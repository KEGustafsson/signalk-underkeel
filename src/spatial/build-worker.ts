import os from "os";
import { parentPort, Worker, workerData } from "worker_threads";
import type { CellInfo } from "../ingest/cells";
import { readCellDirectory } from "../ingest/cell-reader";
import type { ChartFeature, DepthFeature } from "../ingest/features";
import type { CellReach } from "./build-items";
import { cellReach, DEFAULT_BUILD, prepareItems } from "./build-items";
import type { SavedIndex } from "./build-reuse";
import { copiedRoots, savedIndex, unchangedInfo, writeReach } from "./build-reuse";
import type { ChartIndex } from "./chart-index";
import { isNamedHazard, stageChartIndex } from "./chart-index";
import { HazardIndex } from "./hazards";
import type { NodeColumns } from "./node-store";
import type { RootRange } from "./pyramid-build";
import type { RegionPart } from "./pyramid-regions";
import {
  buildRegion,
  cellsReaching,
  cellsRootRange,
  joinRegions,
  rootRegions
} from "./pyramid-regions";

/**
 * Index build off the event loop: a worker thread reads the cells, builds
 * the pyramid and stages it, so the 1 Hz look-ahead keeps running while a
 * new Traficom WFS box is indexed (plan §6). Only the main thread moves it
 * into the index directory: a worker aborted by stop() may run on after the
 * next start() has saved its own index there.
 *
 * The pyramid is built one root at a time from the cells reaching it, the
 * roots spread over `threads` further workers and joined in root order, so
 * the result does not depend on the thread count.
 */

export interface BuildJob {
  /** Cell directories in catalogue order. */
  dirs: string[];
  leafZoom: number;
  indexDir: string;
  /** Threads building roots; `defaultThreads()` when absent. */
  threads?: number;
  /** Heap limit shared by the root threads (MB); none when absent. */
  heapMb?: number;
  /**
   * Cell directories whose content may differ from the saved index's while
   * their DSID does not, as the Traficom WFS cell's after a download. When
   * set, the roots that neither these cells nor any cell with a new DSID
   * reach, in the saved build or now, are copied from the index saved in
   * `indexDir` instead of built.
   */
  changed?: string[];
}

/** One region of roots and the cells that reach it, by directory and catalogue index. */
export interface RegionJob {
  cells: { dir: string; ref: number }[];
  leafZoom: number;
  region: RootRange;
}

export type RegionRunner = (job: RegionJob) => Promise<NodeColumns>;

/**
 * One thread per core but one, at most 4, and at most one per GiB of RAM: three
 * threads on 16 Nauvo cell pairs peaked at 974 MB against 481 MB for one.
 */
export const defaultThreads = (): number =>
  Math.max(1, Math.min(4, os.availableParallelism() - 1, Math.floor(os.totalmem() / 2 ** 30)));

function readFeatures(job: RegionJob): ChartFeature[] {
  return job.cells.flatMap(({ dir, ref }) => readCellDirectory(dir, ref).features);
}

/** Reads one region's cells and builds its roots, holding the features only while preparing. */
export function runRegion(job: RegionJob): NodeColumns {
  const opts = { ...DEFAULT_BUILD, leafZoom: job.leafZoom };
  return buildRegion(prepareItems(readFeatures(job), opts), opts, job.region);
}

interface Survey {
  infos: CellInfo[];
  hazards: DepthFeature[];
  reaches: CellReach[];
  /** Catalogue indices of the cells read anew: all of them without a saved index. */
  changed: number[];
}

/**
 * Reads each cell once for what the index keeps of it: provenance, named
 * hazards and reach. A cell the saved index holds unchanged keeps its saved
 * hazards and reach, and only its DSID is read.
 */
function survey(job: BuildJob, saved: SavedIndex | undefined): Survey {
  const opts = { ...DEFAULT_BUILD, leafZoom: job.leafZoom };
  const out: Survey = { infos: [], hazards: [], reaches: [], changed: [] };
  job.dirs.forEach((dir, i) => {
    const was = saved?.cells[i];
    const info = was && !job.changed?.includes(dir) ? unchangedInfo(dir, was) : undefined;
    if (saved && info) {
      out.infos.push(info);
      out.hazards.push(...(saved.hazards.get(i) ?? []));
      out.reaches.push(saved.reaches[i] as CellReach);
      return;
    }
    const cell = readCellDirectory(dir, i);
    out.infos.push(cell.info);
    out.hazards.push(...cell.features.filter(isNamedHazard));
    out.reaches.push(cellReach(cell.features, opts));
    out.changed.push(i);
  });
  return out;
}

/** A built index with what the next build reuses. */
export interface BuiltIndex extends ChartIndex {
  reaches: CellReach[];
  roots: { built: number; copied: number };
}

/** The chart index of `job.dirs`, the pyramid built region by region through `run`. */
export async function buildByRegion(job: BuildJob, run: RegionRunner): Promise<BuiltIndex> {
  const { minZoom } = DEFAULT_BUILD;
  const saved = job.changed ? savedIndex(job.indexDir, job.dirs, job.leafZoom) : undefined;
  const s = survey(job, saved);
  const range = cellsRootRange(s.reaches, minZoom);
  const roots = range ? rootRegions(range) : [];
  const copies = saved
    ? copiedRoots(
        saved,
        s.changed.flatMap((i) => [s.reaches[i], saved.reaches[i]] as CellReach[]),
        roots
      )
    : new Map<number, NodeColumns>();
  const parts: RegionPart[] = await Promise.all(
    roots.map(async (region, k) => ({
      region,
      cols:
        copies.get(k) ??
        (await run({
          cells: cellsReaching(region, minZoom, s.reaches).map((ref) => ({
            dir: job.dirs[ref] as string,
            ref
          })),
          leafZoom: job.leafZoom,
          region
        }))
    }))
  );
  return {
    catalogue: { version: 1, cells: s.infos },
    pyramid: joinRegions(minZoom, job.leafZoom, parts),
    hazards: new HazardIndex(s.hazards),
    reaches: s.reaches,
    roots: { built: roots.length - copies.size, copied: copies.size }
  };
}

const transfers = (cols: NodeColumns): ArrayBuffer[] =>
  Object.values(cols).map((c: NodeColumns[keyof NodeColumns]) => c.buffer as ArrayBuffer);

type Reply = { cols?: NodeColumns; error?: string };

/**
 * Region builds on `size` threads running this file, each taking the next
 * region when it finishes one. A thread that dies, out of memory for one,
 * fails every region still to come, so the build fails rather than waits.
 */
export function regionPool(
  size: number,
  file = __filename,
  heapMb?: number
): { run: RegionRunner; close: () => void } {
  // The threads run at once, so each gets its share of the build's limit.
  const resourceLimits =
    heapMb === undefined
      ? undefined
      : { maxOldGenerationSizeMb: Math.max(64, Math.floor(heapMb / size)) };
  const queue: { job: RegionJob; done: (r: Reply) => void }[] = [];
  const idle: Worker[] = [];
  const busy = new Map<Worker, (r: Reply) => void>();
  let failure: string | undefined;
  const pump = (): void => {
    while (failure === undefined && idle.length > 0 && queue.length > 0) {
      const w = idle.pop() as Worker;
      const task = queue.shift() as (typeof queue)[number];
      busy.set(w, task.done);
      w.postMessage(task.job);
    }
  };
  const die = (w: Worker, message: string): void => {
    failure ??= message;
    const i = idle.indexOf(w);
    if (i >= 0) {
      idle.splice(i, 1);
    }
    busy.get(w)?.({ error: failure });
    busy.delete(w);
    queue.splice(0).forEach((t) => t.done({ error: failure }));
  };
  const workers = Array.from({ length: size }, () => {
    const w = new Worker(file, { workerData: { regions: true }, resourceLimits });
    w.on("message", (r: Reply) => {
      const done = busy.get(w);
      busy.delete(w);
      idle.push(w);
      done?.(r);
      pump();
    });
    w.on("error", (err) => die(w, err.message));
    w.on("exit", (code) => die(w, `region thread exited with code ${code}`));
    idle.push(w);
    return w;
  });
  const run: RegionRunner = (job) =>
    new Promise((resolve, reject) => {
      const done = (r: Reply) => (r.cols ? resolve(r.cols) : reject(new Error(r.error)));
      if (failure !== undefined) {
        done({ error: failure });
        return;
      }
      queue.push({ job, done });
      pump();
    });
  const close = (): void => {
    workers.forEach((w) => {
      w.removeAllListeners("exit");
      void w.terminate();
    });
  };
  return { run, close };
}

type Staged = { staging: string; roots: BuiltIndex["roots"] };

function stage(job: BuildJob, index: BuiltIndex): Staged {
  const staging = stageChartIndex(job.indexDir, index);
  writeReach(staging, index.reaches);
  return { staging, roots: index.roots };
}

/** Builds and stages the index; resolves with the staging directory and the roots built. */
export async function runBuild(job: BuildJob): Promise<Staged> {
  const threads = job.threads ?? defaultThreads();
  if (threads <= 1) {
    return stage(job, await buildByRegion(job, (j) => Promise.resolve(runRegion(j))));
  }
  const pool = regionPool(threads, __filename, job.heapMb);
  try {
    return stage(job, await buildByRegion(job, pool.run));
  } finally {
    pool.close();
  }
}

function serveRegions(port: NonNullable<typeof parentPort>): void {
  port.on("message", (job: RegionJob) => {
    try {
      const cols = runRegion(job);
      port.postMessage({ cols }, transfers(cols));
    } catch (err) {
      port.postMessage({ error: (err as Error).message });
    }
  });
}

// The Traficom WFS worker imports this module with its own job, which it leaves alone.
const data = workerData as { regions?: boolean; dirs?: unknown } | undefined;
if (parentPort && data?.regions) {
  serveRegions(parentPort);
} else if (parentPort && data?.dirs) {
  const port = parentPort;
  runBuild(workerData as BuildJob).then(
    (r) => port.postMessage({ ok: true, staging: r.staging }),
    (err: Error) => port.postMessage({ ok: false, error: err.message })
  );
}
