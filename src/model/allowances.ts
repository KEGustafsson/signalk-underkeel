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

/**
 * Draft change at roll angle `roll`. A fin keel rises as the boat heels,
 * T·(cos φ − 1) ≤ 0; bilge and wing keels can dig in, which a table gives.
 * "none" ignores heel, which never understates the draft of a fin keel.
 */
export function heel(roll: number | undefined, draft: number, model: HeelModel): Term {
  const phi = Math.abs(roll ?? 0);
  if (model.kind === "fin") {
    return { value: draft * (Math.cos(phi) - 1), sigma: 0 };
  }
  if (model.kind === "table" && model.points.length > 0) {
    const pts = [...model.points].sort((a, b) => a.heel - b.heel);
    const first = pts[0] as { heel: number; delta: number };
    const last = pts[pts.length - 1] as { heel: number; delta: number };
    if (phi <= first.heel) {
      return { value: first.delta, sigma: 0 };
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as { heel: number; delta: number };
      const b = pts[i] as { heel: number; delta: number };
      if (phi <= b.heel) {
        const f = (phi - a.heel) / (b.heel - a.heel);
        return { value: a.delta + f * (b.delta - a.delta), sigma: 0 };
      }
    }
    return { value: last.delta, sigma: 0 };
  }
  return { value: 0, sigma: 0 };
}

/** Wave allowance W = c·Hs, σ = 50 % of W. */
export function waveAllowance(significantHeight: number | undefined, factor: number): Term {
  const value = factor * Math.max(0, significantHeight ?? 0);
  return { value, sigma: 0.5 * value };
}
