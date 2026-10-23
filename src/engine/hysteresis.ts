import type { UnderKeelState } from "../foundation/state";
import type { LookaheadOptions, LookaheadResult, Thresholds } from "./lookahead";

/**
 * State hysteresis (plan §4.7). A state is raised after `raiseTicks`
 * consecutive ticks at or above it, and lowered after `lowerTicks`
 * consecutive ticks below it with P under (1 − `lowerMargin`) × the held
 * state's threshold, counting only footprints within the time window that
 * raises that state. `unknown` and `off` describe missing input, not risk,
 * so they pass through at once (safety invariant 3): stale input is never
 * held as an earlier `normal`. The risk state before them stays held, so a
 * gap in input does not skip the lowering ticks; a higher state after the
 * gap is taken at once.
 */

export type StateWindows = Pick<LookaheadOptions, "thresholds" | "alarmWithin" | "warnWithin">;

export interface HysteresisOptions {
  raiseTicks: number;
  lowerTicks: number;
  lowerMargin: number;
}

export const DEFAULT_HYSTERESIS: HysteresisOptions = {
  raiseTicks: 2,
  lowerTicks: 5,
  lowerMargin: 0.2
};

const RANK: Record<UnderKeelState, number> = {
  normal: 0,
  alert: 1,
  warn: 2,
  alarm: 3,
  unknown: -1,
  off: -1
};

function thresholdOf(state: UnderKeelState, th: Thresholds): number {
  return state === "alarm" ? th.alarm : state === "warn" ? th.warn : th.alert;
}

export class Hysteresis {
  /** The last published risk-ranked result whose state is being held; never unknown or off. */
  private held?: LookaheadResult;
  /** The last tick passed through unknown or off. */
  private gap = false;
  private raising = 0;
  private lowering = 0;

  constructor(
    private readonly windows: StateWindows,
    private readonly opts: HysteresisOptions = DEFAULT_HYSTERESIS
  ) {}

  /** The result to publish this tick, given the engine's raw result. */
  next(raw: LookaheadResult): LookaheadResult {
    if (RANK[raw.state] < 0) {
      this.gap = true;
      this.raising = 0;
      this.lowering = 0;
      return raw;
    }
    const held = this.held;
    const gap = this.gap;
    this.gap = false;
    if (!held) {
      return this.take(raw);
    }
    const up = RANK[raw.state] > RANK[held.state];
    const down = RANK[raw.state] < RANK[held.state];
    if (!down && (gap || !up)) {
      return this.take(raw);
    }
    this.raising = up ? this.raising + 1 : 0;
    const clearing = down && this.clearOf(raw, held.state);
    this.lowering = clearing ? this.lowering + 1 : 0;
    if (
      (up && this.raising >= this.opts.raiseTicks) ||
      (clearing && this.lowering >= this.opts.lowerTicks)
    ) {
      return this.take(raw);
    }
    // Hold the state and its reason; the numbers stay current. So does the
    // escape heading: one found from an earlier position and course may now
    // point at the shoal, so none is better than the held one.
    return {
      ...raw,
      state: held.state,
      reason: held.reason,
      worst: raw.worst ?? held.worst
    };
  }

  /**
   * P within the held state's window is under its threshold less the
   * margin. Risk beyond the window cannot raise the state, so it must not
   * hold it either; a result without footprints falls back to its overall P.
   */
  private clearOf(raw: LookaheadResult, held: UnderKeelState): boolean {
    const w = this.windows;
    const within = held === "alarm" ? w.alarmWithin : held === "warn" ? w.warnWithin : Infinity;
    let risk = raw.footprints.length > 0 ? 0 : (raw.risk ?? 0);
    for (const f of raw.footprints) {
      if (f.t <= within) {
        risk = Math.max(risk, f.risk);
      }
    }
    return risk < (1 - this.opts.lowerMargin) * thresholdOf(held, w.thresholds);
  }

  private take(raw: LookaheadResult): LookaheadResult {
    this.held = raw;
    this.raising = 0;
    this.lowering = 0;
    return raw;
  }
}
