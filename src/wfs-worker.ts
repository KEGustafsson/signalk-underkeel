import { parentPort, workerData } from "worker_threads";
import type { WfsDownload, WfsFetch } from "./ingest/wfs";
import { downloadWfsCell } from "./ingest/wfs";
import type { BuildJob, BuildReply, IndexParts } from "./spatial/build-worker";
import { runBuild, transfers } from "./spatial/build-worker";

/**
 * A Traficom WFS refresh off the event loop: download, parse, clip and write the cell, then
 * build and stage the index. The 10 km box is a 22 MB page whose parse and clip blocked the
 * main thread for 0.3–0.5 s on x86 and took 100 MB of its heap. The staging directory, the
 * index with its pyramid columns moved, and the feature counts come back; the main thread
 * commits the index.
 */

export interface WfsJob {
  download: Omit<WfsDownload, "fetch" | "signal" | "now"> & { now: string };
  build: BuildJob;
}

export type WfsCounts = Awaited<ReturnType<typeof downloadWfsCell>>;

export interface WfsReply extends BuildReply {
  features?: WfsCounts;
}

export async function runWfsJob(
  job: WfsJob,
  fetch: WfsFetch,
  signal?: AbortSignal
): Promise<{ staging: string; index: IndexParts; features: WfsCounts }> {
  const features = await downloadWfsCell({
    ...job.download,
    now: new Date(job.download.now),
    fetch,
    signal
  });
  return { ...(await runBuild(job.build)), features };
}

if (parentPort && workerData) {
  const port = parentPort;
  runWfsJob(workerData as WfsJob, globalThis.fetch).then(
    (r) => port.postMessage({ ok: true, ...r } satisfies WfsReply, transfers(r.index.cols)),
    (err: Error) => port.postMessage({ ok: false, error: err.message } satisfies WfsReply)
  );
}
