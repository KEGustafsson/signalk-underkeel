import type { ChildProcess } from "child_process";
import { fork } from "child_process";

/**
 * Index builds and S-57 reads run in child processes, not worker threads: glibc's per-thread
 * malloc arenas and gdal3.js's WebAssembly memory stayed with the server after a worker thread
 * exited, 1.1–1.6 GB RSS after the 20-cell Waddenzee build against 288 MB for a process that
 * only loaded the saved index (x86). A child process returns all of it when it exits.
 */

/** The end of a child's stderr kept for its error message. */
const STDERR_TAIL = 2048;

const OUT_OF_MEMORY = /heap out of memory|Reached heap limit/i;

export interface LimitedChild {
  child: ChildProcess;
  /** The last of what the child wrote to stderr. */
  stderr: () => string;
  /** Whether V8 reported the child's heap limit reached. */
  outOfMemory: () => boolean;
}

/**
 * Runs `script` in Node with its old-generation heap capped at `heapMb`, messages passed with
 * V8's serializer so typed arrays arrive whole. The server's own V8 flags are not passed on,
 * so a server started with `--max-old-space-size` no longer lifts the cap. MALLOC_ARENA_MAX=2
 * bounds glibc's arenas while the child runs: 1 cut the RSS left after a whole Waddenzee build
 * from 1.1–1.6 GB to 577 MB. stdout is dropped; stderr is kept for the error message.
 * With `group`, the child leads a process group of its own on POSIX, which the processes it
 * starts join, so `killGroup` ends them all.
 */
export function forkLimited(script: string, heapMb: number, group = false): LimitedChild {
  const child = fork(script, [], {
    execArgv: [`--max-old-space-size=${heapMb}`],
    env: { ...process.env, MALLOC_ARENA_MAX: "2" },
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    detached: group && process.platform !== "win32",
    windowsHide: true
  });
  let tail = "";
  // Seen as it arrives: on macOS V8's native stack trace pushes the line out of the tail.
  let outOfMemory = false;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (s: string) => {
    const joined = tail + s;
    outOfMemory ||= OUT_OF_MEMORY.test(joined);
    tail = joined.slice(-STDERR_TAIL);
  });
  return { child, stderr: () => tail.trim(), outOfMemory: () => outOfMemory };
}

/**
 * Ends `child` at once with the processes it started, on POSIX the process group it leads
 * (`forkLimited` with `group`). The group is signalled only while the child has not been
 * reaped, so its id cannot have passed to another process. On Windows only the child is
 * ended; the processes it started exit when their channel to it closes (`exitWithParent`).
 */
export function killGroup(child: ChildProcess): void {
  if (
    process.platform !== "win32" &&
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // ESRCH: no such group, as when the child was started without one.
    }
  }
  child.kill("SIGKILL");
}

/**
 * Ends this child process when its parent goes: an IPC child otherwise outlives a server
 * that was killed or crashed, and goes on building.
 */
export function exitWithParent(): void {
  process.once("disconnect", () => process.exit(1));
}

/** Sends `m` to the parent, resolving once it is written to the channel. */
export function sendToParent(m: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("not a child process"));
      return;
    }
    process.send(m, undefined, {}, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}
