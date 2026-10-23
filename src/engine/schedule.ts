import type { VesselModel } from "../model/vessel";
import type { Motion } from "./fan";
import type { FootprintResult, LookaheadOptions } from "./lookahead";
import type { Refine } from "./verdict";

/** When a tick's footprints are scored (plan §4.8, step rule). */

/**
 * Seconds between footprints. The plan's Δt applies at ordinary speeds; a
 * fast boat would leave gaps between Δt-spaced hulls, so the step shrinks
 * until consecutive footprints (hull length plus the buffer at both ends)
 * still touch.
 */
export function stepFor(sog: number, vessel: VesselModel, opts: LookaheadOptions): number {
  const reach = vessel.length + 2 * opts.positionBuffer;
  return sog > 0 ? Math.min(opts.step, reach / sog) : opts.step;
}

/**
 * Footprints per tick at most. Coarse footprints still touch up to
 * reach / SOG apart, so a long horizon at low speed spaces them wider
 * rather than scoring more; only when that is not enough is the horizon cut.
 */
export const MAX_FOOTPRINTS = 400;

/** Footprint times on the step grid, and that step. */
export interface Schedule {
  times: number[];
  step: number;
}

/**
 * Every step out to `warnWithin`, the widest window a state is raised in;
 * beyond it every k-th step, the most that still leaves consecutive
 * footprints touching, so a slow boat's long horizon costs tens of
 * footprints instead of hundreds. Footprint length and buffer only grow
 * with t, so the coarse footprints still cover the swept hull. When the
 * horizon would need more than MAX_FOOTPRINTS, only the coarse spacing
 * grows, toward the touching limit and off the step grid: the windows keep
 * the step, so the alarm and warn checks and the time to shoal keep its
 * resolution. The step grows only when the warn window alone would need
 * more. The grid steps a coarse footprint skips can be scored where it
 * decides a time.
 */
export function scheduleFor(m: Motion, vessel: VesselModel, opts: LookaheadOptions): Schedule {
  const gapFree = m.sog > 0 ? (vessel.length + 2 * opts.positionBuffer) / m.sog : opts.step;
  const near = Math.min(m.horizon, opts.warnWithin);
  const step = Math.min(
    gapFree,
    Math.max(stepFor(m.sog, vessel, opts), near / (MAX_FOOTPRINTS - 1))
  );
  const dense = Math.min(MAX_FOOTPRINTS - 1, Math.ceil(near / step - 1e-9));
  // Steps between coarse footprints from the first at or past the window: k, or more
  // and off the grid where the footprints left would not reach the horizon.
  const left = MAX_FOOTPRINTS - 1 - dense;
  const k = Math.max(1, Math.floor(gapFree / step + 1e-9));
  const per =
    left > 0 ? Math.min(gapFree / step, Math.max(k, (m.horizon / step - dense) / left)) : 0;
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
 * `from`, the previous scheduled time, is set for a coarse footprint, which
 * then also covers the steps it skipped.
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
    firstTime(i: number, holds: (f: FootprintResult) => boolean): number {
      const f = footprints[i] as FootprintResult;
      const before = footprints[i - 1];
      // A coarse footprint may lie off the step grid; the grid steps before it are scored.
      const first = before ? Math.floor(before.t / step + 1e-9) + 1 : 0;
      for (let j = first; j * step < f.t - 1e-9; j++) {
        if (holds(score(j * step, false))) {
          return j * step;
        }
      }
      return f.t;
    }
  };
}
