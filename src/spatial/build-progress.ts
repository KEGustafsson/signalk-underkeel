/**
 * Progress of an index build, posted by the build process to the server over its IPC channel
 * (`runBuildProcess`) so the status can say how far a chart box rebuild has come. A process
 * runs one build, so the sink is set once per process; with none set, as for a build on the
 * calling thread, reports go nowhere.
 */

/** download: the Traficom WFS box; cells: S-57 cells read; roots: pyramid roots built; save. */
export type BuildPhase = "download" | "cells" | "roots" | "save";

export interface BuildProgress {
  phase: BuildPhase;
  done?: number;
  total?: number;
}

/** The IPC message a build process sends before its reply. */
export interface ProgressMessage {
  progress: BuildProgress;
}

export const isProgress = (m: unknown): m is ProgressMessage =>
  typeof m === "object" && m !== null && "progress" in m;

let sink: ((p: BuildProgress) => void) | undefined;

/** Where this process's build reports go; undefined stops them. */
export function reportProgressTo(fn: ((p: BuildProgress) => void) | undefined): void {
  sink = fn;
}

export function reportProgress(p: BuildProgress): void {
  sink?.(p);
}

/** Least time between two reports of the same phase, ms. */
export const PROGRESS_EVERY_MS = 2000;

/**
 * `send` called at a phase's first report and its last (done = total), and otherwise at most
 * every `everyMs`: a build of a few hundred roots sends a few dozen messages, not hundreds.
 */
export function throttled(
  send: (p: BuildProgress) => void,
  everyMs = PROGRESS_EVERY_MS,
  now: () => number = Date.now
): (p: BuildProgress) => void {
  let phase: BuildPhase | undefined;
  let at = -Infinity;
  return (p) => {
    const t = now();
    const last = p.done !== undefined && p.done === p.total;
    if (p.phase !== phase || last || t - at >= everyMs) {
      phase = p.phase;
      at = t;
      send(p);
    }
  };
}
