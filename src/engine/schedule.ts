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
 * Footprints per tick at most. Footprints a step apart still touch up to
 * reach / SOG, so a long horizon at low speed takes longer steps rather
 * than more footprints; only when that is not enough is the horizon cut.
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
 * with t, so the coarse footprints still cover the swept hull. Times stay
 * on the step grid, so the steps a coarse footprint skips can be scored
 * where it decides a time.
 */
export function scheduleFor(m: Motion, vessel: VesselModel, opts: LookaheadOptions): Schedule {
  const gapFree = m.sog > 0 ? (vessel.length + 2 * opts.positionBuffer) / m.sog : opts.step;
  const step = Math.min(
    gapFree,
    Math.max(stepFor(m.sog, vessel, opts), m.horizon / (MAX_FOOTPRINTS - 1))
  );
  const horizon = Math.min(m.horizon, step * (MAX_FOOTPRINTS - 1));
  const n = Math.ceil(horizon / step - 1e-9);
  const dense = Math.ceil(Math.min(horizon, opts.warnWithin) / step - 1e-9);
  const k = Math.max(1, Math.floor(gapFree / step + 1e-9));
  const times: number[] = [];
  for (let i = 0; i < n; i += i < dense ? 1 : k) {
    times.push(i * step);
  }
  times.push(horizon);
  return { times, step };
}

/** Scores the footprint at t; `stop` lets its chart walk end at certain land. */
export type Score = (t: number, stop: boolean) => FootprintResult;

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
  const footprints = times.map((t) => score(t, true));
  return {
    footprints,
    complete(i: number): FootprintResult {
      const f = footprints[i] as FootprintResult;
      if (!f.partial) {
        return f;
      }
      const full = score(f.t, false);
      footprints[i] = full;
      return full;
    },
    firstTime(i: number, holds: (f: FootprintResult) => boolean): number {
      const f = footprints[i] as FootprintResult;
      const before = footprints[i - 1];
      for (let j = before ? Math.round(before.t / step) + 1 : 0; j * step < f.t - 1e-9; j++) {
        if (holds(score(j * step, false))) {
          return j * step;
        }
      }
      return f.t;
    }
  };
}
