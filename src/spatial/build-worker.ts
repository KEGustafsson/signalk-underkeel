import os from "os";
import { parentPort, Worker, workerData } from "worker_threads";
import type { CellInfo } from "../ingest/cells";
import { readCellDirectory } from "../ingest/cell-reader";
import type { ChartFeature, DepthFeature } from "../ingest/features";
import type { CellReach } from "./build-items";
import { cellReach, DEFAULT_BUILD, prepareItems } from "./build-items";
import type { ChartIndex } from "./chart-index";
import { isNamedHazard, stageChartIndex } from "./chart-index";
import { HazardIndex } from "./hazards";
import type { NodeColumns } from "./node-store";
import type { RootRange } from "./pyramid-build";
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

/** Reads each cell once for what the index keeps of it: provenance, named hazards and reach. */
function survey(job: BuildJob): {
  infos: CellInfo[];
  hazards: DepthFeature[];
  reaches: CellReach[];
} {
  const opts = { ...DEFAULT_BUILD, leafZoom: job.leafZoom };
  const out = {
    infos: [] as CellInfo[],
    hazards: [] as DepthFeature[],
    reaches: [] as CellReach[]
  };
  job.dirs.forEach((dir, i) => {
    const cell = readCellDirectory(dir, i);
    out.infos.push(cell.info);
    out.hazards.push(...cell.features.filter(isNamedHazard));
    out.reaches.push(cellReach(cell.features, opts));
  });
  return out;
}

/** The chart index of `job.dirs`, the pyramid built region by region through `run`. */
export async function buildByRegion(job: BuildJob, run: RegionRunner): Promise<ChartIndex> {
  const { minZoom } = DEFAULT_BUILD;
  const { infos, hazards, reaches } = survey(job);
  const range = cellsRootRange(reaches, minZoom);
  const regions = range ? rootRegions(range) : [];
  const parts = await Promise.all(
    regions.map(async (region) => ({
      region,
      cols: await run({
        cells: cellsReaching(region, minZoom, reaches).map((ref) => ({
          dir: job.dirs[ref] as string,
          ref
        })),
        leafZoom: job.leafZoom,
        region
      })
    }))
  );
  return {
    catalogue: { version: 1, cells: infos },
    pyramid: joinRegions(minZoom, job.leafZoom, parts),
    hazards: new HazardIndex(hazards)
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
  // The threads run at once and share one limit beside the build worker's own: the worker
  // holds every region's columns and the joined body, so it keeps its whole limit.
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

/** Builds the index and returns the staging directory it was written to. */
export async function runBuild(job: BuildJob): Promise<string> {
  const threads = job.threads ?? defaultThreads();
  if (threads <= 1) {
    return stageChartIndex(
      job.indexDir,
      await buildByRegion(job, (j) => Promise.resolve(runRegion(j)))
    );
  }
  const pool = regionPool(threads, __filename, job.heapMb);
  try {
    return stageChartIndex(job.indexDir, await buildByRegion(job, pool.run));
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

if (parentPort && workerData) {
  const port = parentPort;
  if ((workerData as { regions?: boolean }).regions) {
    serveRegions(port);
  } else {
    runBuild(workerData as BuildJob).then(
      (staging) => port.postMessage({ ok: true, staging }),
      (err: Error) => port.postMessage({ ok: false, error: err.message })
    );
  }
}
