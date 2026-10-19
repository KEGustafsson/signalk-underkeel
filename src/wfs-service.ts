import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import type { LonLat } from "./foundation/geo";
import { haversine } from "./foundation/geo";
import type { WfsConfig } from "./config";
import type { Bbox, WfsFetch } from "./ingest/wfs";
import { boxAround, downloadWfsCell, WFS_CELL_NAME, WFS_NOTICE } from "./ingest/wfs";
import type { Clock } from "./monitor";
import type { BuildJob } from "./spatial/build-worker";
import type { ChartIndex } from "./spatial/chart-index";
import { loadChartIndex } from "./spatial/chart-index";

/**
 * Keeps a Traficom WFS box around the vessel (plan §4.2). When the vessel
 * is more than half the box radius from its centre, the box around the
 * current position is downloaded, the index is rebuilt off the event loop
 * and handed over; until then the previous index stays in use.
 */

export type IndexBuilder = (job: BuildJob, signal: AbortSignal) => Promise<ChartIndex>;

/** Settles once every worker aborted so far has exited. */
let exits: Promise<unknown> = Promise.resolve();

/**
 * Builds in a worker thread from the compiled `lib/spatial/build-worker.js`.
 * An aborted worker runs, and may still be saving into the index directory,
 * until terminate() resolves, so its build rejects only then and the next
 * build starts only then; stop() itself returns at once.
 */
export const workerBuilder: IndexBuilder = async (job, signal) => {
  await exits;
  if (signal.aborted) {
    throw new Error("aborted");
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "spatial", "build-worker.js"), {
      workerData: job
    });
    const abort = (): void => {
      const exit = worker.terminate().catch(() => undefined);
      exits = Promise.all([exits, exit]);
      void exit.then(() => reject(new Error("aborted")));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (m: { ok: boolean; error?: string }) => {
      if (signal.aborted) {
        return;
      }
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (m.ok) {
        resolve(loadChartIndex(job.indexDir));
      } else {
        reject(new Error(m.error ?? "index build failed"));
      }
    });
    worker.once("error", (err) => {
      if (signal.aborted) {
        return;
      }
      signal.removeEventListener("abort", abort);
      reject(err);
    });
  });
};

/** The box in use, as saved in `<data dir>/wfs/box.json`. */
export interface WfsBox {
  bbox: Bbox;
  centre: LonLat;
  radiusKm: number;
  catzoc: number;
  fetchedAt: string;
  features: { depthAreas: number; dredgedAreas: number; soundings: number };
}

export interface WfsStatus {
  notice: string;
  box?: WfsBox;
  busy: boolean;
  lastError?: string;
}

export interface WfsServiceDeps {
  config: WfsConfig;
  /** `<data dir>/wfs`: holds the cell directory and box.json. */
  dir: string;
  indexDir: string;
  leafZoom: number;
  /** ENC cell directories, built before the WFS cell so they keep their catalogue order. */
  encDirs: () => string[];
  fetch: WfsFetch;
  build: IndexBuilder;
  clock: Pick<Clock, "now" | "setInterval" | "clearInterval">;
  position: () => LonLat | undefined;
  onIndex: (index: ChartIndex) => void;
  error: (message: string) => void;
}

/** Position checks; a download is due only when the vessel has left the inner half of the box. */
const CHECK_EVERY_MS = 10_000;
/** No two downloads start closer together than this, and after a failure the wait is longer. */
const MIN_INTERVAL_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 300_000;

export class WfsService {
  private box?: WfsBox;
  private busy = false;
  private lastAttempt = -Infinity;
  private lastError?: string;
  private timer: unknown;
  private controller?: AbortController;

  constructor(private readonly deps: WfsServiceDeps) {
    this.box = this.readBox();
  }

  get cellDir(): string {
    return path.join(this.deps.dir, WFS_CELL_NAME);
  }

  /** The saved cell, when one was downloaded and indexed before. */
  savedCell(): string | undefined {
    return this.box && fs.existsSync(this.cellDir) ? this.cellDir : undefined;
  }

  start(): void {
    this.timer = this.deps.clock.setInterval(() => void this.check(), CHECK_EVERY_MS);
    void this.check();
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
    return (
      b === undefined ||
      b.radiusKm !== this.deps.config.radiusKm ||
      b.catzoc !== this.deps.config.catzoc ||
      haversine(pos, b.centre) > (b.radiusKm * 1000) / 2
    );
  }

  async check(): Promise<void> {
    const pos = this.deps.position();
    const now = this.deps.clock.now();
    if (!pos || !this.due(pos, now)) {
      return;
    }
    this.busy = true;
    this.lastAttempt = now;
    const controller = new AbortController();
    this.controller = controller;
    const radiusKm = this.deps.config.radiusKm;
    const bbox = boxAround(pos, radiusKm);
    try {
      const features = await downloadWfsCell({
        fetch: this.deps.fetch,
        url: this.deps.config.url,
        bbox,
        dir: this.cellDir,
        now: new Date(now),
        catzoc: this.deps.config.catzoc,
        signal: controller.signal
      });
      const index = await this.deps.build(
        {
          dirs: [...this.deps.encDirs(), this.cellDir],
          leafZoom: this.deps.leafZoom,
          indexDir: this.deps.indexDir
        },
        controller.signal
      );
      const box: WfsBox = {
        bbox,
        centre: pos,
        radiusKm,
        catzoc: this.deps.config.catzoc,
        fetchedAt: new Date(now).toISOString(),
        features
      };
      fs.writeFileSync(path.join(this.deps.dir, "box.json"), JSON.stringify(box));
      this.box = box;
      this.lastError = undefined;
      this.deps.onIndex(index);
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      this.lastError = (err as Error).message;
      this.deps.error(`Traficom WFS depths: ${this.lastError}`);
    } finally {
      this.busy = false;
    }
  }

  private readBox(): WfsBox | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.deps.dir, "box.json"), "utf8")) as WfsBox;
    } catch {
      return undefined;
    }
  }
}
