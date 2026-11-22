/**
 * Dynamic draft terms (plan §4.6): the wave allowance, with its 1σ, in metres. The keel counts
 * at its full static depth: no squat (a small boat at its speeds sinks a few centimetres, which
 * Barrass's ship formula overstates and the margin and the draft's σ cover) and no heel (a fin
 * keel's lift lasts only until a tack or a bear-away, and upright the keel is at its lowest), both
 * decided in plan §4.6.
 */

export interface Term {
  value: number;
  sigma: number;
}

/** Wave allowance W = c·Hs, σ = 50 % of W. */
export function waveAllowance(significantHeight: number | undefined, factor: number): Term {
  const value = factor * Math.max(0, significantHeight ?? 0);
  return { value, sigma: 0.5 * value };
}
