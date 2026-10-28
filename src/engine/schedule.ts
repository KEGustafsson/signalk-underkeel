import type { VesselModel } from "../model/vessel";
import type { Motion } from "./fan";
import type { FootprintResult, LookaheadOptions } from "./lookahead";
import type { Refine } from "./verdict";

/** When a tick's footprints are scored (plan §4.8, step rule). */

/**
 * Seconds between the hulls a footprint sweeps: hull positions this far apart touch with no
 * buffer at all, so the footprints cover the track at any position buffer and the buffer
 * stands for the position's uncertainty alone. No time on the schedule, and no hull a
 * footprint takes in, depends on the buffer, so a wider buffer scores the same footprints
 * wider and can only raise P (invariant 2).
 */
export function sweepFor(sog: number, vessel: VesselModel, opts: LookaheadOptions): number {
  return sog > 0 ? Math.min(opts.step, vessel.length / sog) : opts.step;
}

/** A coarse footprint beyond the warn window sweeps at most this many hull lengths of track. */
export const COARSE_SWEEP = 3;

/**
 * Footprints per tick at most. A long horizon at low speed spaces the coarse
 * footprints wider, up to COARSE_SWEEP hull lengths, rather than scoring more;
 * only when that is not enough is the horizon cut.
 */
export const MAX_FOOTPRINTS = 400;

/** Footprint times on the step grid, and that step. */
export interface Schedule {
  times: number[];
  step: number;
}

/**
 * Every plan step out to `warnWithin`, the widest window a state is raised in; beyond it every
 * k-th step, so a coarse footprint sweeps at most COARSE_SWEEP hull lengths and a slow boat's
 * long horizon costs tens of footprints instead of hundreds. Each footprint sweeps the hulls
 * since the one before (`sweepFor`), so the footprints cover the track whatever their spacing.
 * When the horizon would need more than MAX_FOOTPRINTS, only the coarse spacing grows, toward
 * COARSE_SWEEP hull lengths and off the step grid: the windows keep the step, so the alarm and
 * warn checks and the time to shoal keep its resolution. The step grows only when the warn
 * window alone would need more. The grid steps a coarse footprint skips can be scored where it
 * decides a time. Nothing here depends on the position buffer.
 */
export function scheduleFor(m: Motion, vessel: VesselModel, opts: LookaheadOptions): Schedule {
  const coarse = m.sog > 0 ? (COARSE_SWEEP * vessel.length) / m.sog : opts.step;
  const near = Math.min(m.horizon, opts.warnWithin);
  const step = Math.max(opts.step, near / (MAX_FOOTPRINTS - 1));
  const dense = Math.min(MAX_FOOTPRINTS - 1, Math.ceil(near / step - 1e-9));
  // Steps between coarse footprints from the first at or past the window: k, or more
  // and off the grid where the footprints left would not reach the horizon.
  const left = MAX_FOOTPRINTS - 1 - dense;
  const k = Math.max(1, Math.floor(coarse / step + 1e-9));
  const per =
    left > 0 ? Math.max(k, Math.min(coarse / step, (m.horizon / step - dense) / left)) : 0;
  const horizon = Math.min(m.horizon, (dense + per * left) * step);
  const times: number[] = [];
  for (let i = 0; i < dense; i++) {
    times.push(i * step);
  }
  for (let j = 0; (dense + j * per) * step < horizon - 1e-9; j++) {
    times.push((dense + j * per) * step);
  }
  times.push(horizon);
  return { times, step };
}

/**
 * Scores the footprint at t; `stop` lets its chart walk end at certain land.
 * `from`, the time before it, is set for every footprint after t = 0, which
 * then sweeps the hulls since then: for a coarse footprint also the steps it
 * skipped.
 */
export type Score = (t: number, stop: boolean, from?: number) => FootprintResult;

/**
 * The schedule's footprints, each walk allowed to stop at certain land,
 * and what `classify` needs to read them as if every step had been scored
 * in full: the skipped steps before a coarse footprint, and a full walk of
 * a stopped one where its coverage is asked.
 */
export function scoreSchedule(
  times: number[],
  step: number,
  score: Score
): Refine & { footprints: FootprintResult[] } {
  const footprints = times.map((t, i) => score(t, true, times[i - 1]));
  return {
    footprints,
    complete(i: number): FootprintResult {
      const f = footprints[i] as FootprintResult;
      if (!f.partial) {
        return f;
      }
      const full = score(f.t, false, times[i - 1]);
      footprints[i] = full;
      return full;
    },
    firstTime(i: number, holds: (f: FootprintResult) => boolean): number | undefined {
      const f = footprints[i] as FootprintResult;
      const before = footprints[i - 1];
      // A coarse footprint may lie off the step grid; the grid steps before it are scored.
      const first = before ? Math.floor(before.t / step + 1e-9) + 1 : 0;
      for (let j = first; j * step < f.t - 1e-9; j++) {
        if (holds(score(j * step, false, j > 0 ? (j - 1) * step : undefined))) {
          return j * step;
        }
      }
      // A turning boat's hull also covers ground inside the arc that no step reaches: only a
      // plan step sets the time, as when every step is scored. A footprint within one step of
      // the one before is that plan step alone, already scored.
      const single = before === undefined || f.t - before.t <= step + 1e-9;
      // Scored as a plan step, sweeping from the grid step before it, also off the grid.
      return single || holds(score(f.t, false, (Math.ceil(f.t / step - 1e-9) - 1) * step))
        ? f.t
        : undefined;
    }
  };
}
