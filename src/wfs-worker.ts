import { parentPort, workerData } from "worker_threads";
import { cellSources, cellsMissing, savedCatalogue, sourceKeys } from "./index-loader";
import type { Bbox, WfsDownload, WfsFetch } from "./ingest/wfs";
import { downloadWfsCell } from "./ingest/wfs";
import { readBox } from "./spatial/build-box";
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
  /** Absent for a box of ENC cells alone: the index is rebuilt around the vessel only. */
  download?: Omit<WfsDownload, "fetch" | "signal" | "now"> & { now: string };
  /** The S-57 cells found under it are built ahead of `build.dirs`. */
  cellsDir?: string;
  /**
   * Finding no S-57 cell in `cellsDir` fails the refresh and keeps the index in use: the
   * drive holding the cells has most likely been unmounted. Without it the refresh fails so
   * too while the index saved in `build.indexDir` holds S-57 cells (`cellsMissing`).
   */
  cellsRequired?: boolean;
  /** Builds in this box (plan §4.2), not whole. */
  box?: Bbox;
  build: BuildJob;
}

export type WfsCounts = Awaited<ReturnType<typeof downloadWfsCell>>;

export const NO_FEATURES: WfsCounts = { depthAreas: 0, dredgedAreas: 0, soundings: 0 };

export interface WfsReply extends BuildReply {
  features?: WfsCounts;
}

/**
 * The S-57 cells under `cellsDir`, found before the download. Scanning and stamping the 698
 * NOAA cells took 31–47 ms (x86), so the refresh does it, not the event loop.
 */
export function refreshCells(job: WfsJob): string[] {
  const cells = cellSources(job.cellsDir);
  if (job.cellsDir === undefined || cells.length > 0) {
    return cells;
  }
  // With no index in use, or one of WFS depths alone, the saved catalogue still tells.
  if (job.cellsRequired || cellsMissing(job.cellsDir, cells, savedCatalogue(job.build.indexDir))) {
    throw new Error(`no S-57 cell found in ${job.cellsDir}`);
  }
  return cells;
}

/**
 * The build once the WFS cell is downloaded: `cells` first and, for a box, every source's
 * stamp as it is now, so a cell downloaded for the first time is recorded by its edition.
 */
export function refreshBuild(job: WfsJob, cells: string[]): BuildJob {
  const { changed, ...build } = { ...job.build, dirs: [...cells, ...job.build.dirs] };
  if (job.box) {
    return { ...build, box: { bbox: job.box, sources: sourceKeys(build.dirs) } };
  }
  // Past its box an index built in one is no coverage: none of its roots is copied.
  return changed && !readBox(build.indexDir) ? { ...build, changed } : build;
}

export async function runWfsJob(
  job: WfsJob,
  fetch: WfsFetch,
  signal?: AbortSignal
): Promise<{ staging: string; index: IndexParts; features: WfsCounts }> {
  const cells = refreshCells(job);
  const features = job.download
    ? await downloadWfsCell({ ...job.download, now: new Date(job.download.now), fetch, signal })
    : NO_FEATURES;
  return { ...(await runBuild(refreshBuild(job, cells))), features };
}

if (parentPort && workerData) {
  const port = parentPort;
  runWfsJob(workerData as WfsJob, globalThis.fetch).then(
    (r) => port.postMessage({ ok: true, ...r } satisfies WfsReply, transfers(r.index.cols)),
    (err: Error) => port.postMessage({ ok: false, error: err.message } satisfies WfsReply)
  );
}
