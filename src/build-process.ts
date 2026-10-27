import fs from "fs";
import path from "path";
import { forkLimited, killGroup } from "./foundation/child-process";
import { usableMemory } from "./foundation/memory";
import type { WfsFetch } from "./ingest/wfs";
import { downloadWfsCell } from "./ingest/wfs";
import type { WfsCounts, WfsJob, WfsReply } from "./wfs-worker";
import { NO_FEATURES, refreshBuild, refreshCells } from "./wfs-worker";
import type { BuildProgress } from "./spatial/build-progress";
import { isProgress } from "./spatial/build-progress";
import type { BuildJob, BuildReply } from "./spatial/build-worker";
import { adoptIndex } from "./spatial/build-worker";
import { readsSettled } from "./spatial/block-reader";
import type { ChartIndex } from "./spatial/chart-index";
import { commitChartIndex, loadChartIndexAsync, removeStaging } from "./spatial/chart-index";

/**
 * Index builds and Traficom WFS refreshes in child processes (plan §6), each run's progress
 * passed on as the child posts it, and the staged index committed on the main thread.
 */

/** Called with each progress report the build posts (`build-progress.ts`). */
export type OnProgress = (p: BuildProgress) => void;

export type IndexBuilder = (
  job: BuildJob,
  signal: AbortSignal,
  progress?: OnProgress
) => Promise<ChartIndex>;

/** Downloads the box, writes the cell and rebuilds the index with it. */
export type WfsRefresher = (
  job: WfsJob,
  signal: AbortSignal,
  progress?: OnProgress
) => Promise<{ index: ChartIndex; features: WfsCounts }>;

/** Settles once every build process aborted so far has exited. */
let exits: Promise<unknown> = Promise.resolve();

/**
 * Old-generation heap for a build process: a quarter of the RAM, 256 MB to 2 GB. The ENC pair
 * plus a 10 km WFS box at leaf zoom 20 builds in under 96 MB; without a limit an oversized
 * build grows until the kernel ends the whole Signal K server on a 1 GB Pi 3 or Cerbo GX.
 */
export function workerHeapLimitMb(totalBytes = usableMemory()): number {
  return Math.min(2048, Math.max(256, Math.floor(totalBytes / 4 / 2 ** 20)));
}

/**
 * Runs the compiled `script` in a child process (`forkLimited`) with `data` and resolves with
 * its staged reply. The child only stages; the caller moves the result into place on the main
 * thread, and never for an aborted run, so a build still exiting cannot replace an index
 * saved after it was aborted. An abort kills the child and its S-57 reader (`killGroup`); its
 * run rejects once the child has exited and its staging is removed, and the next run starts
 * only then. stop() itself returns at once. A child that ends without a reply fails the run.
 * Progress messages the child sends before its reply go to `progress`.
 */
export async function runBuildProcess<R extends BuildReply>(
  script: string,
  data: object,
  signal: AbortSignal,
  indexDir?: string,
  heapMb = workerHeapLimitMb(),
  progress?: OnProgress
): Promise<R & { staging: string }> {
  await exits;
  if (signal.aborted) {
    throw new Error("aborted");
  }
  return new Promise((resolve, reject) => {
    const { child, stderr, outOfMemory } = forkLimited(script, heapMb, true);
    const { pid } = child;
    let replied = false;
    // Staging the child left half-written: once it has exited nothing else writes there.
    const cleanup = (): void => {
      if (indexDir !== undefined && pid !== undefined) {
        removeStaging(indexDir, (p) => p === pid);
      }
    };
    const closed = new Promise<void>((r) => child.once("close", () => r()));
    const abort = (): void => {
      killGroup(child);
      const exit = closed.then(cleanup).catch(() => undefined);
      exits = Promise.all([exits, exit]);
      void exit.then(() => reject(new Error("aborted")));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("message", (m: R | { progress: BuildProgress }) => {
      if (isProgress(m)) {
        if (!replied && !signal.aborted) {
          progress?.(m.progress);
        }
        return;
      }
      replied = true;
      // It exits once the reply is sent; killed, it cannot linger holding its memory.
      child.kill("SIGKILL");
      if (signal.aborted) {
        if (m.staging) {
          fs.rmSync(m.staging, { recursive: true, force: true });
        }
        return;
      }
      signal.removeEventListener("abort", abort);
      if (m.ok && m.staging) {
        resolve(m as R & { staging: string });
      } else {
        reject(new Error(m.error ?? "index build failed"));
      }
    });
    // A child that could not start, or ended without a reply: the index in use stays.
    child.once("error", (err) => {
      if (!signal.aborted && !replied) {
        signal.removeEventListener("abort", abort);
        killGroup(child);
        reject(err);
      }
    });
    child.once("close", (code: number | null, end: string | null) => {
      if (signal.aborted || replied) {
        return;
      }
      signal.removeEventListener("abort", abort);
      try {
        cleanup();
      } catch {
        // Left for the next start's recovery, which removes staging of exited processes.
      }
      const how = code === null ? `signal ${end ?? "?"}` : `code ${code}`;
      const tail = stderr() === "" ? "" : `: ${stderr()}`;
      reject(
        new Error(
          outOfMemory()
            ? `index build stopped at the ${heapMb} MB heap limit${tail}`
            : `index build process exited with ${how} without a result${tail}`
        )
      );
    });
    // A child that cannot take the job exits, and "close" reports it.
    child.send(data, () => undefined);
  });
}

/**
 * Moves a staged index into `indexDir` and adopts the one the build posted, unless the run
 * was aborted meanwhile. Reading the saved index back blocked the event loop for 52–61 ms
 * with the Nauvo pair and a 10 km WFS box at leaf zoom 20, 258–292 ms with 32 cells (x86).
 */
async function commit(
  indexDir: string,
  m: BuildReply & { staging: string },
  signal: AbortSignal
): Promise<ChartIndex> {
  await readsSettled(indexDir);
  if (signal.aborted) {
    fs.rmSync(m.staging, { recursive: true, force: true });
    throw new Error("aborted");
  }
  commitChartIndex(indexDir, m.staging);
  if (m.index) {
    return adoptIndex(m.index);
  }
  // A pyramid above HELD_WHOLE_NODES is not posted: the committed file is read block by block,
  // its blocks verified off the event loop.
  const index = await loadChartIndexAsync(indexDir);
  if (signal.aborted) {
    throw new Error("aborted");
  }
  return index;
}

/** Builds in a child process from the compiled `lib/spatial/build-worker.js`. */
export const workerBuilder: IndexBuilder = async (job, signal, progress) => {
  const script = path.join(__dirname, "spatial", "build-worker.js");
  const heapMb = workerHeapLimitMb();
  const data = { ...job, heapMb };
  const m = await runBuildProcess(script, data, signal, job.indexDir, heapMb, progress);
  return await commit(job.indexDir, m, signal);
};

/**
 * The whole refresh in a child process from the compiled `lib/wfs-worker.js`, which fetches
 * with its own global fetch.
 */
export const workerRefresher: WfsRefresher = async (job, signal, progress) => {
  const script = path.join(__dirname, "wfs-worker.js");
  const heapMb = workerHeapLimitMb();
  const data: WfsJob = { ...job, build: { ...job.build, heapMb } };
  const { indexDir } = job.build;
  const m = await runBuildProcess<WfsReply>(script, data, signal, indexDir, heapMb, progress);
  const features = m.features ?? NO_FEATURES;
  return { index: await commit(job.build.indexDir, m, signal), features };
};

/** The download on this thread with `fetch`, then `build`: for an injected fetch or builder. */
export function inThreadRefresher(fetch: WfsFetch, build: IndexBuilder): WfsRefresher {
  return async (job, signal, progress) => {
    const cells = refreshCells(job);
    if (job.download) {
      progress?.({ phase: "download" });
    }
    const features = job.download
      ? await downloadWfsCell({ ...job.download, now: new Date(job.download.now), fetch, signal })
      : NO_FEATURES;
    await readsSettled(job.build.indexDir);
    return { index: await build(refreshBuild(job, cells), signal, progress), features };
  };
}
