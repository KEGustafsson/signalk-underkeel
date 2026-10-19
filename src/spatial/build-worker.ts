import { parentPort, workerData } from "worker_threads";
import { readCellDirectory } from "../ingest/cell-reader";
import { buildChartIndex, saveChartIndex } from "./chart-index";

/**
 * Index build off the event loop: a worker thread reads the cells, builds
 * the pyramid and saves it, so the 1 Hz look-ahead keeps running while a
 * new Traficom WFS box is indexed (plan §6).
 */

export interface BuildJob {
  /** Cell directories in catalogue order. */
  dirs: string[];
  leafZoom: number;
  indexDir: string;
}

export function runBuild(job: BuildJob): void {
  const index = buildChartIndex(
    job.dirs.map((d, i) => readCellDirectory(d, i)),
    { leafZoom: job.leafZoom }
  );
  saveChartIndex(job.indexDir, index);
}

if (parentPort && workerData) {
  try {
    runBuild(workerData as BuildJob);
    parentPort.postMessage({ ok: true });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: (err as Error).message });
  }
}
