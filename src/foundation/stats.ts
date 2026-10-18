/**
 * Standard normal CDF Φ(x), via the Abramowitz–Stegun 7.1.26 erf
 * approximation (absolute error < 1.5e-7). Exact at ±Infinity.
 */
export function normalCdf(x: number): number {
  if (x === Infinity) {
    return 1;
  }
  if (x === -Infinity) {
    return 0;
  }
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * P(X < 0) for X ~ N(mean, sigma²). With sigma 0 the answer is 0 or 1;
 * mean −Infinity (land) is always 1.
 */
export function probabilityBelowZero(mean: number, sigma: number): number {
  if (mean === -Infinity) {
    return 1;
  }
  if (!(sigma > 0)) {
    return mean < 0 ? 1 : 0;
  }
  return normalCdf(-mean / sigma);
}
