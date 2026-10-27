import fs from "fs";
import { forkLimited, killGroup } from "./foundation/child-process";
import { usableMemory } from "./foundation/memory";
import path from "path";
import { MAX_POSITION_BUFFER } from "./engine/fan";
import type { LonLat } from "./foundation/geo";
import { haversine, project } from "./foundation/geo";
import type { WfsConfig } from "./config";
import { readCellInfo } from "./ingest/cell-reader";
import type { Bbox, WfsFetch } from "./ingest/wfs";
import {
  boxAround,
  downloadWfsCell,
  edgeAhead,
  WFS_CELL_NAME,
  WFS_NOTICE,
  WFS_SOURCE
} from "./ingest/wfs";
import type { WfsCounts, WfsJob, WfsReply } from "./wfs-worker";
import { NO_FEATURES, refreshBuild, refreshCells } from "./wfs-worker";
import type { Clock } from "./monitor";
import { readBox } from "./spatial/build-box";
import { MAX_CHART_BUFFER } from "./spatial/chart-position";
import type { BuildJob, BuildReply } from "./spatial/build-worker";
import { adoptIndex } from "./spatial/build-worker";
import { readsSettled } from "./spatial/block-reader";
import type { ChartIndex } from "./spatial/chart-index";
import {
  commitChartIndex,
  indexDirProblem,
  loadChartIndexAsync,
  removeStaging
} from "./spatial/chart-index";

/**
 * Keeps a Traficom WFS box around the vessel (plan §4.2). When the vessel
 * is more than half the box radius from its centre, or at its speed would
 * reach the box edge less the look-ahead and the no-coverage band inside the
 * edge before another refresh could arrive, a box centred ahead along its course is downloaded and the index
 * rebuilt off the event loop, then handed over; until then the previous
 * index stays in use.
 */

export type IndexBuilder = (job: BuildJob, signal: AbortSignal) => Promise<ChartIndex>;

/** Downloads the box, writes the cell and rebuilds the index with it. */
export type WfsRefresher = (
  job: WfsJob,
  signal: AbortSignal
) => Promise<{ index: ChartIndex; features: WfsCounts }>;

/** Settles once every build process aborted so far has exited. */
let exits: Promise<unknown> = Promise.resolve();

/**
 * Old-generation heap for a build process: a quarter of the RAM, 256 MB to 2 GB. The ENC pair
 * plus a 10 km WFS box at leaf zoom 20 builds in under 96 MB; without a limit an oversized
 * build grows until the kernel ends the whole Signal K server on a 1 GB Pi 3 or Cerbo GX.
 */
export function workerHeapLimitMb(totalBytes = usableMemory()): number {
  return Math.min(2048, Math.max(256, Math.floor(totalBytes / 4 / 2 ** 20)));
}

/**
 * Runs the compiled `script` in a child process (`forkLimited`) with `data` and resolves with
 * its staged reply. The child only stages; the caller moves the result into place on the main
 * thread, and never for an aborted run, so a build still exiting cannot replace an index
 * saved after it was aborted. An abort kills the child and its S-57 reader (`killGroup`); its
 * run rejects once the child has exited and its staging is removed, and the next run starts
 * only then. stop() itself returns at once. A child that ends without a reply fails the run.
 */
export async function runBuildProcess<R extends BuildReply>(
  script: string,
  data: object,
  signal: AbortSignal,
  indexDir?: string,
  heapMb = workerHeapLimitMb()
): Promise<R & { staging: string }> {
  await exits;
  if (signal.aborted) {
    throw new Error("aborted");
  }
  return new Promise((resolve, reject) => {
    const { child, stderr, outOfMemory } = forkLimited(script, heapMb, true);
    const { pid } = child;
    let replied = false;
    // Staging the child left half-written: once it has exited nothing else writes there.
    const cleanup = (): void => {
      if (indexDir !== undefined && pid !== undefined) {
        removeStaging(indexDir, (p) => p === pid);
      }
    };
    const closed = new Promise<void>((r) => child.once("close", () => r()));
    const abort = (): void => {
      killGroup(child);
      const exit = closed.then(cleanup).catch(() => undefined);
      exits = Promise.all([exits, exit]);
      void exit.then(() => reject(new Error("aborted")));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("message", (m: R) => {
      replied = true;
      // It exits once the reply is sent; killed, it cannot linger holding its memory.
      child.kill("SIGKILL");
      if (signal.aborted) {
        if (m.staging) {
          fs.rmSync(m.staging, { recursive: true, force: true });
        }
        return;
      }
      signal.removeEventListener("abort", abort);
      if (m.ok && m.staging) {
        resolve(m as R & { staging: string });
      } else {
        reject(new Error(m.error ?? "index build failed"));
      }
    });
    // A child that could not start, or ended without a reply: the index in use stays.
    child.once("error", (err) => {
      if (!signal.aborted && !replied) {
        signal.removeEventListener("abort", abort);
        killGroup(child);
        reject(err);
      }
    });
    child.once("close", (code: number | null, end: string | null) => {
      if (signal.aborted || replied) {
        return;
      }
      signal.removeEventListener("abort", abort);
      try {
        cleanup();
      } catch {
        // Left for the next start's recovery, which removes staging of exited processes.
      }
      const how = code === null ? `signal ${end ?? "?"}` : `code ${code}`;
      const tail = stderr() === "" ? "" : `: ${stderr()}`;
      reject(
        new Error(
          outOfMemory()
            ? `index build stopped at the ${heapMb} MB heap limit${tail}`
            : `index build process exited with ${how} without a result${tail}`
        )
      );
    });
    // A child that cannot take the job exits, and "close" reports it.
    child.send(data, () => undefined);
  });
}

/**
 * Moves a staged index into `indexDir` and adopts the one the build posted, unless the run
 * was aborted meanwhile. Reading the saved index back blocked the event loop for 52–61 ms
 * with the Nauvo pair and a 10 km WFS box at leaf zoom 20, 258–292 ms with 32 cells (x86).
 */
async function commit(
  indexDir: string,
  m: BuildReply & { staging: string },
  signal: AbortSignal
): Promise<ChartIndex> {
  await readsSettled(indexDir);
  if (signal.aborted) {
    fs.rmSync(m.staging, { recursive: true, force: true });
    throw new Error("aborted");
  }
  commitChartIndex(indexDir, m.staging);
  if (m.index) {
    return adoptIndex(m.index);
  }
  // A pyramid above HELD_WHOLE_NODES is not posted: the committed file is read block by block,
  // its blocks verified off the event loop.
  const index = await loadChartIndexAsync(indexDir);
  if (signal.aborted) {
    throw new Error("aborted");
  }
  return index;
}

/** Builds in a child process from the compiled `lib/spatial/build-worker.js`. */
export const workerBuilder: IndexBuilder = async (job, signal) => {
  const script = path.join(__dirname, "spatial", "build-worker.js");
  const heapMb = workerHeapLimitMb();
  const m = await runBuildProcess(script, { ...job, heapMb }, signal, job.indexDir, heapMb);
  return await commit(job.indexDir, m, signal);
};

/**
 * The whole refresh in a child process from the compiled `lib/wfs-worker.js`, which fetches
 * with its own global fetch.
 */
export const workerRefresher: WfsRefresher = async (job, signal) => {
  const script = path.join(__dirname, "wfs-worker.js");
  const heapMb = workerHeapLimitMb();
  const data: WfsJob = { ...job, build: { ...job.build, heapMb } };
  const m = await runBuildProcess<WfsReply>(script, data, signal, job.build.indexDir, heapMb);
  const features = m.features ?? NO_FEATURES;
  return { index: await commit(job.build.indexDir, m, signal), features };
};

/** The download on this thread with `fetch`, then `build`: for an injected fetch or builder. */
export function inThreadRefresher(fetch: WfsFetch, build: IndexBuilder): WfsRefresher {
  return async (job, signal) => {
    const cells = refreshCells(job);
    const features = job.download
      ? await downloadWfsCell({ ...job.download, now: new Date(job.download.now), fetch, signal })
      : NO_FEATURES;
    await readsSettled(job.build.indexDir);
    return { index: await build(refreshBuild(job, cells), signal), features };
  };
}

/** The box in use, as saved in `<data dir>/wfs/box.json`. */
export interface WfsBox {
  bbox: Bbox;
  centre: LonLat;
  radiusKm: number;
  /** Absent for a box of ENC cells alone. */
  catzoc?: number;
  fetchedAt: string;
  features: { depthAreas: number; dredgedAreas: number; soundings: number };
  /** How long its download and index build took; the next box is planned on it. */
  durationMs?: number;
}

export interface WfsStatus {
  notice: string;
  box?: WfsBox;
  busy: boolean;
  lastError?: string;
}

/** A box of ENC cells around the vessel, with no WFS download. */
export interface EncBoxConfig {
  radiusKm: number;
}

export interface WfsServiceDeps {
  config: WfsConfig | EncBoxConfig;
  /** `<data dir>/wfs`, or the ENC box's directory: holds box.json and any WFS cell. */
  dir: string;
  indexDir: string;
  leafZoom: number;
  /**
   * The S-57 cells directory, scanned by the refresh off the event loop; its cells are built
   * before the WFS cell so they keep their catalogue order.
   */
  cellsDir?: string;
  /** Builds the ENC cells in the box too (plan §4.2), not whole. */
  inBox: boolean;
  /** The index in use; with none, a refresh is due whatever the saved box says. */
  index: () => ChartIndex | undefined;
  refresh: WfsRefresher;
  clock: Pick<Clock, "now" | "setInterval" | "clearInterval">;
  position: () => LonLat | undefined;
  /** Fresh speed (m/s) and course (radians) over ground, when both are known. */
  motion: () => { sog: number; cog: number } | undefined;
  /** The look-ahead's reach: `distance`, or `minHorizon` seconds at the current speed. */
  lookahead: { distance: number; minHorizon: number };
  /**
   * Hands a rebuilt index over. `changed` holds the boxes of the index in use and the new
   * one when this service built both, so only the WFS cell differs between them.
   */
  onIndex: (index: ChartIndex, changed?: Bbox[]) => void | Promise<void>;
  error: (message: string) => void;
}

/** Position checks; a download is due only when the vessel has left the inner half of the box. */
const CHECK_EVERY_MS = 10_000;
/** No two downloads start closer together than this, and after a failure the wait is longer. */
const MIN_INTERVAL_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 300_000;
/** A refresh is assumed to take this long until one is measured: a z20 rebuild on a Pi 3. */
const DEFAULT_REFRESH_MS = 600_000;
/** A refresh is started this many of the last one's durations before the edge comes in reach. */
const REFRESH_MARGIN = 1.5;
/** The next box is centred at most this share of the radius ahead of the vessel. */
const MAX_LEAD = 0.8;
/**
 * How far inside the box edge a footprint can read no coverage, beyond the look-ahead's reach:
 * the widest position buffer and chart reach, as `block-keeper.ts` keeps. A tile across the
 * edge is no coverage and keeps its survey σ, so its flag reaches 2σ (1 km in CATZOC D) past
 * the footprint's buffer.
 */
const EDGE_BAND = MAX_POSITION_BUFFER + MAX_CHART_BUFFER;

const sameBbox = (a: Bbox | undefined, b: Bbox | undefined): boolean =>
  a !== undefined && b !== undefined && a.every((v, i) => v === b[i]);

export class WfsService {
  private box?: WfsBox;
  /**
   * Whether the index saved in `indexDir` was built in `box` and, when this run built it,
   * handed over. A whole build, another `indexDir` or a crash between the two saves leaves
   * them apart. Found at the first check, after the start plan has recovered a crash-left
   * index or built one.
   */
  private indexed?: boolean;
  /** The box of the last index this service handed over in this run. */
  private handed?: Bbox;
  /** The saved WFS cell was missing or unreadable at start: the box is downloaded again. */
  private cellLost = false;
  private busy = false;
  private lastAttempt = -Infinity;
  private lastError?: string;
  private timer: unknown;
  private controller?: AbortController;

  constructor(private readonly deps: WfsServiceDeps) {
    this.box = this.readBox();
  }

  /** Whether this box downloads Traficom WFS depths, not only builds ENC cells around the vessel. */
  get downloads(): boolean {
    return "url" in this.deps.config;
  }

  /** The box in use, if any. */
  get current(): WfsBox | undefined {
    return this.box;
  }

  get cellDir(): string {
    return path.join(this.deps.dir, WFS_CELL_NAME);
  }

  /**
   * The saved cell, when one was downloaded and indexed before and its DSID still reads. A
   * cell torn by a power cut would otherwise fail the start's whole plan, ENC cells included;
   * it is left out and downloaded again at the first check, as is a cell gone missing.
   */
  savedCell(): string | undefined {
    if (!this.box || !this.downloads) {
      return undefined;
    }
    if (!fs.existsSync(this.cellDir)) {
      this.cellLost = true;
      return undefined;
    }
    try {
      readCellInfo(this.cellDir);
      return this.cellDir;
    } catch (err) {
      this.cellLost = true;
      this.lastError = `saved cell unreadable, downloading it again: ${(err as Error).message}`;
      this.deps.error(`${this.label}: ${this.lastError}`);
      return undefined;
    }
  }

  start(): void {
    const check = (): void =>
      void this.check().catch((err: Error) => this.deps.error(`${this.label}: ${err.message}`));
    this.timer = this.deps.clock.setInterval(check, CHECK_EVERY_MS);
    check();
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.deps.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.controller?.abort();
  }

  status(): WfsStatus {
    return { notice: WFS_NOTICE, box: this.box, busy: this.busy, lastError: this.lastError };
  }

  /** Whether the box no longer reaches far enough around `pos`. */
  private due(pos: LonLat, now: number): boolean {
    const wait = this.lastError ? RETRY_AFTER_ERROR_MS : MIN_INTERVAL_MS;
    if (this.busy || now - this.lastAttempt < wait) {
      return false;
    }
    const b = this.box;
    this.indexed ??= !this.deps.inBox || sameBbox(readBox(this.deps.indexDir)?.bbox, b?.bbox);
    return (
      b === undefined ||
      this.cellLost ||
      !this.indexed ||
      this.deps.index() === undefined ||
      b.radiusKm !== this.deps.config.radiusKm ||
      b.catzoc !== this.catzoc() ||
      haversine(pos, b.centre) > (b.radiusKm * 1000) / 2 ||
      this.edgeSoon(pos, b)
    );
  }

  /**
   * Whether the vessel would reach the box edge, less the look-ahead's reach and EDGE_BAND,
   * before a refresh started now, with the margin, could be handed over. At 15 kn the
   * half-radius rule left 10.8 min of the 10 km box ahead, and a Pi 3 takes 11–14 min. A box
   * too small to hold the band can at best be kept around the vessel: the band counts up to
   * half the radius, or a drifting vessel would rebuild a 2 km box every minute.
   */
  private edgeSoon(pos: LonLat, b: WfsBox): boolean {
    const m = this.deps.motion();
    if (!m || !(m.sog > 0)) {
      return false;
    }
    const look = Math.max(this.deps.lookahead.distance, m.sog * this.deps.lookahead.minHorizon);
    const reach = Math.max(look, Math.min(look + EDGE_BAND, (b.radiusKm * 1000) / 2));
    const travel = (m.sog * REFRESH_MARGIN * this.refreshMs()) / 1000;
    return edgeAhead(pos, m.cog, b.bbox) < travel + reach;
  }

  private get label(): string {
    return this.downloads ? "Traficom WFS depths" : "chart box around the vessel";
  }

  private catzoc(): number | undefined {
    const c = this.deps.config;
    return "url" in c ? c.catzoc : undefined;
  }

  private refreshMs(): number {
    return this.box?.durationMs ?? DEFAULT_REFRESH_MS;
  }

  /**
   * Whether a commit would refuse `indexDir`, so every build would end refused once done:
   * said once, and nothing is downloaded or built until it is set right. Checked again at
   * the retry interval.
   */
  private refused(now: number): boolean {
    const problem = indexDirProblem(this.deps.indexDir);
    if (problem === undefined) {
      return false;
    }
    this.lastAttempt = now;
    if (problem !== this.lastError) {
      this.lastError = problem;
      this.deps.error(`${this.label}: ${problem}`);
    }
    return true;
  }

  /** Where the vessel will be when a refresh started now is handed over, kept inside the box. */
  private centreAhead(pos: LonLat, radiusKm: number): LonLat {
    const m = this.deps.motion();
    if (!m || !(m.sog > 0)) {
      return pos;
    }
    const lead = Math.min((m.sog * this.refreshMs()) / 1000, MAX_LEAD * radiusKm * 1000);
    return project(pos, m.cog, lead);
  }

  async check(): Promise<void> {
    const pos = this.deps.position();
    const now = this.deps.clock.now();
    if (!pos || !this.due(pos, now) || this.refused(now)) {
      return;
    }
    this.busy = true;
    this.lastAttempt = now;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const radiusKm = this.deps.config.radiusKm;
      const centre = this.centreAhead(pos, radiusKm);
      const bbox = boxAround(centre, radiusKm);
      const config = this.deps.config;
      const { inBox, cellsDir } = this.deps;
      // With WFS depths alone in use an empty cells directory loses nothing.
      const cells = this.deps.index()?.catalogue.cells.some((c) => c.source !== WFS_SOURCE);
      const { index, features } = await this.deps.refresh(
        {
          download:
            "url" in config
              ? {
                  url: config.url,
                  bbox,
                  dir: this.cellDir,
                  now: new Date(now).toISOString(),
                  catzoc: config.catzoc
                }
              : undefined,
          cellsDir,
          cellsRequired: !("url" in config) || cells === true,
          box: inBox ? bbox : undefined,
          build: {
            dirs: "url" in config ? [this.cellDir] : [],
            leafZoom: this.deps.leafZoom,
            indexDir: this.deps.indexDir,
            ...(inBox ? {} : { changed: [this.cellDir] })
          }
        },
        controller.signal
      );
      const box: WfsBox = {
        bbox,
        centre,
        radiusKm,
        catzoc: this.catzoc(),
        fetchedAt: new Date(now).toISOString(),
        features,
        durationMs: this.deps.clock.now() - now
      };
      fs.writeFileSync(path.join(this.deps.dir, "box.json"), JSON.stringify(box));
      this.box = box;
      this.lastError = undefined;
      await this.handOver(index, bbox);
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      this.lastError = (err as Error).message;
      this.deps.error(`${this.label}: ${this.lastError}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Puts the index of `bbox` in use. The box stays due until it is, so a failed handover
   * is tried again.
   */
  private async handOver(index: ChartIndex, bbox: Bbox): Promise<void> {
    const changed = this.handed && [this.handed, bbox];
    this.indexed = false;
    await this.deps.onIndex(index, changed);
    this.indexed = true;
    this.cellLost = false;
    this.handed = bbox;
  }

  private readBox(): WfsBox | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.deps.dir, "box.json"), "utf8")) as WfsBox;
    } catch {
      return undefined;
    }
  }
}
