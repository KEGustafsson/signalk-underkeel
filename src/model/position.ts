/**
 * Position uncertainty (plan §4.7). GNSS horizontal 1σ is HDOP times the
 * user-equivalent range error; with no HDOP the default assumes a plain
 * consumer fix.
 */

/** User-equivalent range error, metres. */
export const UERE = 3;

/** Horizontal 1σ when no HDOP is published, metres. */
export const DEFAULT_GNSS_SIGMA = 5;

export function gnssSigma(hdop: number | undefined): number {
  return hdop !== undefined && Number.isFinite(hdop) && hdop > 0 ? hdop * UERE : DEFAULT_GNSS_SIGMA;
}
