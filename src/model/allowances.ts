/**
 * Dynamic draft terms (plan §4.6): squat, heel and wave allowance, each
 * with its 1σ. All lengths in metres, speeds in m/s, angles in radians.
 */

export interface Term {
  value: number;
  sigma: number;
}

const MS_TO_KN = 3600 / 1852;

export interface SquatOptions {
  /** Block coefficient Cb; about 0.35–0.45 for sailing yachts. */
  blockCoefficient: number;
  /** Doubles squat, as in a narrow channel. */
  confined: boolean;
}

/** Barrass open-water squat S = Cb·V²/100 (V in knots, S in metres), σ = 30 % of S. */
export function squat(speed: number, opts: SquatOptions): Term {
  const kn = Math.max(0, speed) * MS_TO_KN;
  const value = ((opts.blockCoefficient * kn * kn) / 100) * (opts.confined ? 2 : 1);
  return { value, sigma: 0.3 * value };
}

/** Heel to draft change, by keel type. Positive values deepen the keel. */
export type HeelModel =
  { kind: "none" } | { kind: "fin" } | { kind: "table"; points: { heel: number; delta: number }[] };

/** Smallest and largest |roll| over the roll window, radians. */
export interface RollRange {
  least: number;
  most: number;
}

/**
 * |roll| above 60° is a bad reading or a knockdown. Past 90° the fin
 * formula would even turn a deeper draft into a shallower one.
 */
export const MAX_ROLL = Math.PI / 3;

/** About two roll periods of a small boat. */
const ROLL_WINDOW_MS = 10_000;

/**
 * Roll samples over the last 10 s. A boat rolling through upright has
 * its full draft at the bottom of each roll, so heel may only lift the
 * keel by what the least roll in the window allows.
 */
export class RollWindow {
  private samples: { roll: number; at: number }[] = [];

  record(roll: number, at: number): void {
    if (this.samples[this.samples.length - 1]?.at === at) {
      return;
    }
    this.samples = [...this.samples.filter((s) => at - s.at < ROLL_WINDOW_MS), { roll, at }];
  }

  /** The |roll| range up to `now`; undefined with no sample or with any above MAX_ROLL. */
  range(now: number): RollRange | undefined {
    const rolls = this.samples
      .filter((s) => now - s.at < ROLL_WINDOW_MS && s.at <= now)
      .map((s) => Math.abs(s.roll));
    if (rolls.length === 0 || rolls.some((r) => !(r <= MAX_ROLL))) {
      return undefined;
    }
    return { least: Math.min(...rolls), most: Math.max(...rolls) };
  }
}

function tableAt(pts: { heel: number; delta: number }[], phi: number): number {
  const first = pts[0] as { heel: number; delta: number };
  if (phi <= first.heel) {
    return first.delta;
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { heel: number; delta: number };
    const b = pts[i] as { heel: number; delta: number };
    if (phi <= b.heel) {
      return a.delta + ((phi - a.heel) / (b.heel - a.heel)) * (b.delta - a.delta);
    }
  }
  return (pts[pts.length - 1] as { heel: number; delta: number }).delta;
}

/**
 * Draft change over the roll range: the deepest the keel reaches. A fin
 * keel rises as the boat heels, T·(cos φ − 1) ≤ 0, so it takes the least
 * roll and, with no roll known, no change. Bilge and wing keels can dig in,
 * which a table gives: its largest change over the range, or over the whole
 * table with no roll known. "none" ignores heel, which never understates
 * the draft of a fin keel.
 */
export function heel(roll: RollRange | undefined, draft: number, model: HeelModel): Term {
  if (model.kind === "fin") {
    return { value: roll ? draft * (Math.cos(roll.least) - 1) : 0, sigma: 0 };
  }
  if (model.kind === "table" && model.points.length > 0) {
    const pts = [...model.points].sort((a, b) => a.heel - b.heel);
    const ends = roll ? [tableAt(pts, roll.least), tableAt(pts, roll.most)] : [];
    const inside = pts.filter((p) => !roll || (p.heel >= roll.least && p.heel <= roll.most));
    return { value: Math.max(...ends, ...inside.map((p) => p.delta)), sigma: 0 };
  }
  return { value: 0, sigma: 0 };
}

/** Wave allowance W = c·Hs, σ = 50 % of W. */
export function waveAllowance(significantHeight: number | undefined, factor: number): Term {
  const value = factor * Math.max(0, significantHeight ?? 0);
  return { value, sigma: 0.5 * value };
}
