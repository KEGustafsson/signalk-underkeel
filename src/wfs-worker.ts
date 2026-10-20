import { parentPort, workerData } from "worker_threads";
import type { WfsDownload, WfsFetch } from "./ingest/wfs";
import { downloadWfsCell } from "./ingest/wfs";
import { readCellDirectory } from "./ingest/cell-reader";
import type { BuildJob } from "./spatial/build-worker";
import { buildChartIndex, stageChartIndex } from "./spatial/chart-index";

/**
 * A Traficom WFS refresh off the event loop: download, parse, clip and write the cell, then
 * build and stage the index. The 10 km box is a 22 MB page whose parse and clip blocked the
 * main thread for 0.3–0.5 s on x86 and took 100 MB of its heap. Only the staging directory
 * and the feature counts come back; the main thread commits the index.
 */

export interface WfsJob {
  download: Omit<WfsDownload, "fetch" | "signal" | "now"> & { now: string };
  build: BuildJob;
}

export type WfsCounts = Awaited<ReturnType<typeof downloadWfsCell>>;

export interface WfsReply {
  ok: boolean;
  staging?: string;
  features?: WfsCounts;
  error?: string;
}

export async function runWfsJob(
  job: WfsJob,
  fetch: WfsFetch,
  signal?: AbortSignal
): Promise<{ staging: string; features: WfsCounts }> {
  const features = await downloadWfsCell({
    ...job.download,
    now: new Date(job.download.now),
    fetch,
    signal
  });
  // As spatial/build-worker's runBuild, which this thread cannot import: that module runs
  // its own job when loaded in a worker.
  const index = buildChartIndex(
    job.build.dirs.map((d, i) => readCellDirectory(d, i)),
    { leafZoom: job.build.leafZoom }
  );
  return { staging: stageChartIndex(job.build.indexDir, index), features };
}

if (parentPort && workerData) {
  const port = parentPort;
  runWfsJob(workerData as WfsJob, globalThis.fetch).then(
    (r) => port.postMessage({ ok: true, ...r } satisfies WfsReply),
    (err: Error) => port.postMessage({ ok: false, error: err.message } satisfies WfsReply)
  );
}
