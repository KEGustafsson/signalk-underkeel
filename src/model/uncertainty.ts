import { probabilityBelowZero } from "../foundation/stats";
import type { Term } from "./allowances";

/**
 * UKC composition (plan §4.7):
 *   UKC = d + h − T − Δh(φ) − S − W − margin
 *   σ²  = σ_d² + σ_h² + σ_T² + σ_S² + σ_W²     (independent terms)
 *   P   = Φ(−UKC / σ)
 * Everything except the charted depth is the same for every tile under a
 * footprint, so it folds into a depth threshold and an extra σ.
 */

export interface WaterLevel {
  /** Height of the water above chart datum, metres. */
  h: number;
  sigma: number;
  /** Where the value came from, e.g. "manual", "fmi:forecast", "fallback". */
  source: string;
  /** Set when the value is a fallback; the engine publishes it. */
  degraded?: string;
}

export interface VesselTerms {
  draft: Term;
  heel: Term;
  squat: Term;
  wave: Term;
  /** Fixed extra margin the user asks for, metres (0 by default). */
  margin: number;
}

/** The charted depth below which the mean UKC is negative. */
export function thresholdDepth(v: VesselTerms, wl: WaterLevel): number {
  return v.draft.value + v.heel.value + v.squat.value + v.wave.value + v.margin - wl.h;
}

/** σ of every term except the charted depth. */
export function sigmaExtra(v: VesselTerms, wl: WaterLevel): number {
  return Math.hypot(wl.sigma, v.draft.sigma, v.heel.sigma, v.squat.sigma, v.wave.sigma);
}

export interface Ukc {
  mean: number;
  sigma: number;
  risk: number;
}

export function ukcAt(charted: number, sigmaCharted: number, v: VesselTerms, wl: WaterLevel): Ukc {
  const mean = charted - thresholdDepth(v, wl);
  const sigma = Math.hypot(sigmaCharted, sigmaExtra(v, wl));
  return { mean, sigma, risk: probabilityBelowZero(mean, sigma) };
}
