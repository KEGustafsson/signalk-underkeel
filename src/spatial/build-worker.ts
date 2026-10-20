import { parentPort, workerData } from "worker_threads";
import { readCellDirectory } from "../ingest/cell-reader";
import { buildChartIndex, stageChartIndex } from "./chart-index";

/**
 * Index build off the event loop: a worker thread reads the cells, builds
 * the pyramid and stages it, so the 1 Hz look-ahead keeps running while a
 * new Traficom WFS box is indexed (plan §6). Only the main thread moves it
 * into the index directory: a worker aborted by stop() may run on after the
 * next start() has saved its own index there.
 */

export interface BuildJob {
  /** Cell directories in catalogue order. */
  dirs: string[];
  leafZoom: number;
  indexDir: string;
}

/** Builds the index and returns the staging directory it was written to. */
export function runBuild(job: BuildJob): string {
  const index = buildChartIndex(
    job.dirs.map((d, i) => readCellDirectory(d, i)),
    { leafZoom: job.leafZoom }
  );
  return stageChartIndex(job.indexDir, index);
}

if (parentPort && workerData) {
  try {
    parentPort.postMessage({ ok: true, staging: runBuild(workerData as BuildJob) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: (err as Error).message });
  }
}
