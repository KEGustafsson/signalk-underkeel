import { isMainThread } from "worker_threads";
import type { WfsConfig } from "./config";
import { cellSources, cellsMissing, savedCatalogue, sourceKeys } from "./index-loader";
import type { EncReader } from "./ingest/enc-read-process";
import type { Bbox, WfsDownload, WfsFetch } from "./ingest/wfs";
import { downloadWfsCell, WFS_SOURCE } from "./ingest/wfs";
import type { ChartIndex } from "./spatial/chart-index";
import { readBox } from "./spatial/build-box";
import { reportProgress } from "./spatial/build-progress";
import type { BuildJob, BuildReply, IndexParts } from "./spatial/build-worker";
import { builtReply, runBuild, serveBuildProcess } from "./spatial/build-worker";

/**
 * A Traficom WFS refresh off the event loop: download, parse, clip and write the cell, then
 * build and stage the index. The 10 km box is a 22 MB page whose parse and clip blocked the
 * main thread for 0.3–0.5 s on x86 and took 100 MB of its heap. It runs in a child process
 * (`runBuildProcess`); the staging directory, the index when the main thread holds it whole,
 * and the feature counts come back, and the main thread commits the index.
 */

export interface WfsJob {
  /** Absent for a box of ENC cells alone: the index is rebuilt around the vessel only. */
  download?: Omit<WfsDownload, "fetch" | "signal" | "now"> & { now: string };
  /** The S-57 cells found under it are built ahead of `build.dirs`. */
  cellsDir?: string;
  /**
   * Finding no S-57 cell in `cellsDir` fails the refresh and keeps the index in use: the
   * charts provider's store is away, as on a drive unmounted. Without it the refresh fails so
   * too while the index saved in `build.indexDir` holds S-57 cells (`cellsMissing`); with
   * WFS depths alone, or none, a WFS download builds whatever ENC the provider has.
   */
  cellsRequired?: boolean;
  /** Builds in this box (plan §4.2), not whole. */
  box?: Bbox;
  build: BuildJob;
}

/** What the box service builds its refresh jobs from (`WfsService`). */
export interface BoxJobDeps {
  config: WfsConfig | { radiusKm: number };
  inBox: boolean;
  cellsDir?: string;
  index: () => ChartIndex | undefined;
  leafZoom: number;
  indexDir: string;
  cacheDir?: string;
  source?: string;
}

/** The refresh of the box `bbox`, started at `now`, with its WFS cell kept in `cellDir`. */
export function refreshJob(deps: BoxJobDeps, cellDir: string, bbox: Bbox, now: number): WfsJob {
  const { config, inBox, cellsDir } = deps;
  const wfs = "url" in config ? config : undefined;
  // With WFS depths alone in use an empty cells directory loses nothing.
  const cells = deps.index()?.catalogue.cells.some((c) => c.source !== WFS_SOURCE);
  return {
    download: wfs && {
      url: wfs.url,
      bbox,
      dir: cellDir,
      now: new Date(now).toISOString(),
      catzoc: wfs.catzoc
    },
    cellsDir,
    // WFS depths are built whatever ENC the charts provider has, but an index of charted
    // hazards is kept while its cells are away, not replaced by depths alone.
    cellsRequired: !wfs || cells === true,
    box: inBox ? bbox : undefined,
    build: {
      dirs: wfs ? [cellDir] : [],
      leafZoom: deps.leafZoom,
      indexDir: deps.indexDir,
      ...(deps.cacheDir === undefined ? {} : { cacheDir: deps.cacheDir }),
      source: deps.source,
      ...(inBox ? {} : { changed: [cellDir] })
    }
  };
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
  signal?: AbortSignal,
  reader?: EncReader
): Promise<{ staging: string; index: IndexParts; features: WfsCounts }> {
  const cells = refreshCells(job);
  if (job.download) {
    reportProgress({ phase: "download" });
  }
  const features = job.download
    ? await downloadWfsCell({ ...job.download, now: new Date(job.download.now), fetch, signal })
    : NO_FEATURES;
  return { ...(await runBuild(refreshBuild(job, cells), reader)), features };
}

if (isMainThread && require.main === module && process.send) {
  serveBuildProcess(
    (job: WfsJob, reader) =>
      runWfsJob(job, globalThis.fetch, undefined, reader).then((r): WfsReply => ({
        ...builtReply(r),
        features: r.features
      })),
    (job) => job.build.heapMb
  );
}
