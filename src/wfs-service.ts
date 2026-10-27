import fs from "fs";
import path from "path";
import { MAX_POSITION_BUFFER } from "./engine/fan";
import type { LonLat } from "./foundation/geo";
import { haversine, project } from "./foundation/geo";
import type { WfsConfig } from "./config";
import type { SizingInput } from "./box-sizing";
import { buildMsAt, fits, nextSize, STEP_KM } from "./box-sizing";
import type { WfsRefresher } from "./build-process";
import type { ChartBoxView } from "./engine/chart-box";
import type { BoxRebuild, BoxSizing, RunningBuild } from "./box-status";
import { boxSummary, rebuildStatus } from "./box-status";
import { readCellInfo } from "./ingest/cell-reader";
import type { Bbox } from "./ingest/wfs";
import {
  boxAround,
  edgeAhead,
  WFS_CELL_NAME,
  WFS_LIMITS,
  WFS_NOTICE,
  WFS_SOURCE
} from "./ingest/wfs";
import type { Clock } from "./monitor";
import { readBox } from "./spatial/build-box";
import { MAX_CHART_BUFFER } from "./spatial/chart-position";
import type { ChartIndex } from "./spatial/chart-index";
import { indexDirProblem } from "./spatial/chart-index";

export type { IndexBuilder, OnProgress, WfsRefresher } from "./build-process";
export {
  inThreadRefresher,
  runBuildProcess,
  workerBuilder,
  workerHeapLimitMb,
  workerRefresher
} from "./build-process";

/**
 * Keeps a Traficom WFS box around the vessel (plan §4.2). When the vessel
 * is more than half the box radius from its centre, or at its speed would
 * reach the box edge less the look-ahead and the no-coverage band inside the
 * edge before another refresh could arrive, a box centred ahead along its course is downloaded and the index
 * rebuilt off the event loop, then handed over; until then the previous
 * index stays in use. At speed the box grows (`box-sizing.ts`); the builds run in child
 * processes (`build-process.ts`).
 */

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
  rebuild?: BoxRebuild;
  sizing: BoxSizing;
  /** One line on the rebuild and the box size, for the plugin status and the panel. */
  summary?: string;
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
  /** The cell cache the builds use (`BuildJob.cacheDir`); none when absent. */
  cacheDir?: string;
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
   * The radius the box may grow to at speed (`box-sizing.ts`), km; it never shrinks below
   * `config.radiusKm`. Without it the box keeps the configured radius.
   */
  maxRadiusKm?: number;
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

const OUT_OF_MEMORY = /heap limit/;

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
  private rebuild?: RunningBuild;
  /** Lowered for this run when a box ran its build out of memory. */
  private ceilingKm?: number;

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
    const rebuild = this.rebuild && rebuildStatus(this.rebuild, this.deps.clock.now());
    const input = this.sizingInput();
    const sizing = { ...nextSize(input, this.box?.radiusKm), capKm: input.capKm, sog: input.sog };
    const lastMs = this.box?.durationMs;
    const summary = boxSummary({ rebuild, lastMs, sizing, input, ceilingKm: this.ceilingKm });
    return {
      notice: WFS_NOTICE,
      box: this.box,
      busy: this.busy,
      lastError: this.lastError,
      sizing,
      ...(rebuild ? { rebuild } : {}),
      ...(summary === undefined ? {} : { summary })
    };
  }

  /** What the look-ahead needs to say when no coverage is this box's edge. */
  view(): ChartBoxView {
    const bbox = this.handed ?? this.box?.bbox;
    const lastMs = this.box?.durationMs;
    return {
      ...(bbox ? { bbox } : {}),
      rebuilding: this.busy,
      failed: !this.busy && this.lastError !== undefined,
      ...(lastMs === undefined ? {} : { lastMs }),
      summary: this.status().summary
    };
  }

  /** The cap the box grows to, never below the configured radius. */
  private capKm(): number {
    const min = this.deps.config.radiusKm;
    let cap = Math.max(min, this.deps.maxRadiusKm ?? min);
    if (this.downloads) {
      cap = Math.min(cap, WFS_LIMITS.maxRadiusKm);
    }
    return Math.max(min, Math.min(cap, this.ceilingKm ?? Infinity));
  }

  private sizingInput(): SizingInput {
    const m = this.deps.motion();
    const sog = m && m.sog > 0 ? m.sog : 0;
    const look = Math.max(this.deps.lookahead.distance, sog * this.deps.lookahead.minHorizon);
    const measured = this.box?.durationMs;
    return {
      sog,
      buildMs: measured ?? DEFAULT_REFRESH_MS,
      builtKm: measured !== undefined && this.box ? this.box.radiusKm : this.deps.config.radiusKm,
      reachM: look + EDGE_BAND,
      margin: REFRESH_MARGIN,
      minKm: this.deps.config.radiusKm,
      capKm: this.capKm()
    };
  }

  /**
   * Whether the box in use is outside the configured radius and the cap, or too small at the
   * current speed where a larger one would do.
   */
  private resize(b: WfsBox): boolean {
    const i = this.sizingInput();
    if (b.radiusKm < i.minKm || b.radiusKm > i.capKm) {
      return true;
    }
    return !fits(b.radiusKm, i) && nextSize(i, b.radiusKm).radiusKm > b.radiusKm;
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
      this.resize(b) ||
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

  /** The build starting now: its radius at the current speed and its expected duration. */
  private begin(now: number, controller: AbortController): RunningBuild {
    const radiusKm = nextSize(this.sizingInput(), this.box?.radiusKm).radiusKm;
    const last = this.box;
    const run: RunningBuild = { startedAt: now, radiusKm };
    if (last?.durationMs !== undefined) {
      run.estimateMs = buildMsAt(radiusKm, { buildMs: last.durationMs, builtKm: last.radiusKm });
    }
    if (this.controller === controller) {
      this.rebuild = run;
    }
    return run;
  }

  /**
   * Reports a failed refresh. A box larger than configured that ran its build out of memory
   * is not tried at that size again in this run.
   */
  private failed(message: string, radiusKm: number): void {
    this.lastError = message;
    this.deps.error(`${this.label}: ${message}`);
    const min = this.deps.config.radiusKm;
    if (OUT_OF_MEMORY.test(message) && radiusKm > min) {
      this.ceilingKm = Math.max(min, Math.floor((radiusKm * 0.75) / STEP_KM) * STEP_KM);
    }
  }

  /** Where the vessel will be when a refresh started now is handed over, kept inside the box. */
  private centreAhead(pos: LonLat, radiusKm: number, refreshMs: number): LonLat {
    const m = this.deps.motion();
    if (!m || !(m.sog > 0)) {
      return pos;
    }
    const lead = Math.min((m.sog * refreshMs) / 1000, MAX_LEAD * radiusKm * 1000);
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
    const run = this.begin(now, controller);
    const { radiusKm } = run;
    try {
      const centre = this.centreAhead(pos, radiusKm, run.estimateMs ?? this.refreshMs());
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
            ...(this.deps.cacheDir === undefined ? {} : { cacheDir: this.deps.cacheDir }),
            ...(inBox ? {} : { changed: [this.cellDir] })
          }
        },
        controller.signal,
        (progress) => {
          if (this.rebuild === run) {
            run.progress = progress;
          }
        }
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
      this.failed((err as Error).message, radiusKm);
    } finally {
      this.busy = false;
      if (this.rebuild === run) {
        this.rebuild = undefined;
      }
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
