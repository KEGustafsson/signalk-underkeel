import os from "os";
import path from "path";
import { isMainThread } from "worker_threads";
import { exitWithParent, forkLimited, killGroup, sendToParent } from "./foundation/child-process";
import { cellSources } from "./index-loader";
import { LayerCache } from "./ingest/cell-cache";
import { isEncFile } from "./ingest/cell-source";
import type { EncReader } from "./ingest/enc-read-process";
import { readInProcess } from "./ingest/enc-read-process";
import type { Bbox } from "./ingest/wfs";
import { boxCells, growBbox } from "./spatial/build-box";

/**
 * The cell cache filled while the chart box is idle. A box moved over cells it had not met
 * before read them through gdal3.js during the rebuild: 22 s of the 38 s cold build of the
 * Waddenzee box against 10.7 s with the cells kept (x86), while the vessel neared the old
 * box's edge. Once a box is in use, a child process at the lowest CPU priority reads the
 * cells the next box can reach into the cache, one at a time, and exits. A rebuild ends it
 * first, so it never runs beside a build. An entry is written through a rename, so one ended
 * halfway leaves only a temporary file, which the next open removes.
 */

export interface WarmJob {
  cellsDir: string;
  cacheDir: string;
  /** Every cell meeting this box is read into the cache, unless it is kept there already. */
  around: Bbox;
  /** The box in use: its cells' entries are never dropped to make room. */
  hold: Bbox;
}

export interface WarmReply {
  read?: number;
  error?: string;
}

/** Reads the cells of `job.around` the cache lacks into it; resolves with how many were read. */
export async function warmCells(job: WarmJob, reader: EncReader = readInProcess): Promise<number> {
  const cells = cellSources(job.cellsDir).filter(isEncFile);
  const cache = LayerCache.open(job.cacheDir, cells);
  if (!cache) {
    return 0;
  }
  cache.hold(boxCells(cells, job.hold, job.cacheDir));
  const want = boxCells(cells, job.around, job.cacheDir).filter((f) => !cache.has(f));
  let read = 0;
  for (const file of want) {
    const layers = (await reader([file])).get(file);
    if (layers) {
      cache.put(file, layers);
      read++;
    }
    // One cell's layers held at a time.
    await cache.flush();
  }
  return read;
}

export interface Warming {
  /** Ends the run; resolves once its process has exited. */
  stop(): Promise<void>;
}

/**
 * Runs `job` in a child process from the compiled `script`, its heap capped at `heapMb`;
 * `done` gets its reply, or why it ended without one, unless it was stopped.
 */
export function startWarming(
  job: WarmJob,
  heapMb: number,
  done: (reply: WarmReply) => void,
  script = path.join(__dirname, "cell-warm.js")
): Warming {
  const { child, stderr } = forkLimited(script, heapMb, true);
  let stopped = false;
  let reply: WarmReply | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code: number | null) => {
      if (!stopped) {
        done(
          reply ?? { error: `cell cache warming exited with ${code ?? "a signal"}: ${stderr()}` }
        );
      }
      resolve();
    });
  });
  child.once("error", () => undefined);
  child.on("message", (m: WarmReply) => (reply = m));
  child.send(job, () => undefined);
  return {
    stop: () => {
      stopped = true;
      killGroup(child);
      return closed;
    }
  };
}

/** What the chart box service tells the warming (`WfsService`). */
export interface BoxWarmer {
  /** A box went in use: the cells within `reachKm` of it are read into the cache. */
  boxInUse(bbox: Bbox, reachKm: number): void;
  /** Ends a run ahead of a build, which reads the cells it may be reading. */
  beforeBuild(): Promise<void>;
  /** Ends a run for good: none starts after it. */
  stop(): void;
}

/** One run at a time through `start`; a run that cannot start is reported to `error`. */
export function boxWarmer(
  start: (around: Bbox, hold: Bbox) => Warming,
  error: (message: string) => void
): BoxWarmer {
  let running: Warming | undefined;
  let stopped = false;
  const end = (): Promise<void> => {
    const r = running;
    running = undefined;
    return r ? r.stop() : Promise.resolve();
  };
  return {
    boxInUse: (bbox, reachKm) => {
      if (stopped) {
        return;
      }
      void end();
      try {
        running = start(growBbox(bbox, reachKm), bbox);
      } catch (err) {
        error(`filling the cell cache failed: ${(err as Error).message}`);
      }
    },
    beforeBuild: end,
    stop: () => {
      stopped = true;
      void end();
    }
  };
}

if (isMainThread && require.main === module && process.send) {
  exitWithParent();
  try {
    // Behind the server and the look-ahead, whatever the cores.
    os.setPriority(19);
  } catch {
    // Not permitted: it runs at the server's priority.
  }
  process.once("message", (job: WarmJob) => {
    warmCells(job)
      .then(
        (read): WarmReply => ({ read }),
        (err: Error): WarmReply => ({ error: err.message })
      )
      .then(sendToParent)
      .finally(() => process.exit(0));
  });
}
