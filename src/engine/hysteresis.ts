import type { UnderKeelState } from "../foundation/state";
import type { LookaheadResult, Thresholds } from "./lookahead";

/**
 * State hysteresis (plan §4.7). A state is raised after `raiseTicks`
 * consecutive ticks at or above it, and lowered after `lowerTicks`
 * consecutive ticks below it with P under (1 − `lowerMargin`) × the held
 * state's threshold. `unknown` and `off` describe missing input, not risk,
 * so they pass through at once (safety invariant 3): stale input is never
 * held as an earlier `normal`.
 */

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
  /** The last published result whose state is being held. */
  private held?: LookaheadResult;
  private raising = 0;
  private lowering = 0;

  constructor(
    private readonly th: Thresholds,
    private readonly opts: HysteresisOptions = DEFAULT_HYSTERESIS
  ) {}

  /** The result to publish this tick, given the engine's raw result. */
  next(raw: LookaheadResult): LookaheadResult {
    const held = this.held;
    if (!held || RANK[raw.state] < 0 || RANK[held.state] < 0) {
      return this.take(raw);
    }
    const up = RANK[raw.state] > RANK[held.state];
    const down = RANK[raw.state] < RANK[held.state];
    this.raising = up ? this.raising + 1 : 0;
    const clearing = down && this.clearOf(raw, held.state);
    this.lowering = clearing ? this.lowering + 1 : 0;
    if (
      (up && this.raising >= this.opts.raiseTicks) ||
      (clearing && this.lowering >= this.opts.lowerTicks)
    ) {
      return this.take(raw);
    }
    if (!up && !down) {
      this.held = raw;
      return raw;
    }
    // Hold the state and its reason; the numbers stay current.
    return {
      ...raw,
      state: held.state,
      reason: held.reason,
      worst: raw.worst ?? held.worst,
      escapeHeading: raw.escapeHeading ?? held.escapeHeading
    };
  }

  /** P is under the held state's threshold less the margin. */
  private clearOf(raw: LookaheadResult, held: UnderKeelState): boolean {
    return (raw.risk ?? 0) < (1 - this.opts.lowerMargin) * thresholdOf(held, this.th);
  }

  private take(raw: LookaheadResult): LookaheadResult {
    this.held = raw;
    this.raising = 0;
    this.lowering = 0;
    return raw;
  }
}
