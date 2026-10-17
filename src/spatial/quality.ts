import type { Catzoc } from "../ingest/features";

/**
 * Survey quality → 1σ uncertainty (plan §4.4). The S-57 CATZOC accuracies
 * are read as ~95 % bounds, so σ = bound / 2.
 */

interface Accuracy {
  /** Horizontal accuracy bound in metres. */
  position: number;
  /** Depth accuracy bound = fixed + fraction · depth, in metres. */
  depthFixed: number;
  depthFraction: number;
}

const C: Accuracy = { position: 500, depthFixed: 2.0, depthFraction: 0.05 };
const TWICE_C: Accuracy = {
  position: 2 * C.position,
  depthFixed: 2 * C.depthFixed,
  depthFraction: 2 * C.depthFraction
};

const TABLE: Record<Exclude<Catzoc, 6>, Accuracy> = {
  1: { position: 5, depthFixed: 0.5, depthFraction: 0.01 },
  2: { position: 20, depthFixed: 1.0, depthFraction: 0.02 },
  3: { position: 50, depthFixed: 1.0, depthFraction: 0.02 },
  4: C,
  // D is "worse than C"; the plan uses 2 × C.
  5: TWICE_C
};

/** σ_depth inside a swept area, where the swept depth is guaranteed. */
export const SWEPT_SIGMA_D = 0.1;

export interface QualityOptions {
  /** Accuracy used for CATZOC U and for areas without any M_QUAL zone. */
  unassessed: Accuracy;
}

export const DEFAULT_QUALITY: QualityOptions = { unassessed: TWICE_C };

export interface Sigma {
  sigmaP: number;
  sigmaD: number;
}

export function accuracyFor(catzoc: Catzoc | undefined, opts = DEFAULT_QUALITY): Accuracy {
  return catzoc === undefined || catzoc === 6 ? opts.unassessed : TABLE[catzoc];
}

/**
 * 1σ uncertainties for a depth under a quality zone. A stated POSACC or
 * SOUACC only ever widens the table value: the cell's own figure can admit
 * a worse survey than its CATZOC, never claim a better one.
 */
export function sigmaFor(
  catzoc: Catzoc | undefined,
  depth: number,
  stated: { posacc?: number; souacc?: number } = {},
  opts = DEFAULT_QUALITY
): Sigma {
  const acc = accuracyFor(catzoc, opts);
  const d = Number.isFinite(depth) ? Math.max(0, depth) : 0;
  const position = Math.max(acc.position, stated.posacc ?? 0);
  const depthBound = Math.max(acc.depthFixed + acc.depthFraction * d, stated.souacc ?? 0);
  return { sigmaP: position / 2, sigmaD: depthBound / 2 };
}
