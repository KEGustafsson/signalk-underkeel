import type { NodeValues } from "./node-store";
import { FLAGS } from "./node-store";
import type { Walk } from "./walk";
import { REACH_FLAGS, riskAt } from "./walk";

/** Where a `minDepthOver` walk (`pyramid.ts`) need not descend a split tile. */

/**
 * A split tile's flags are the union of its children's, so stopping early
 * at one carrying these would report a gap or an unassessed survey that
 * the footprint itself may not touch. Such tiles are always descended.
 */
export const PRECISE_FLAGS = REACH_FLAGS;

/** Below this, a split tile's risk bound is negligible and its children need not be visited. */
export const RISK_STOP_BELOW = 1e-4;

/**
 * Whether a split tile may answer for its children. Its bound must clear
 * `clearAbove` and carry no coverage or assessment flags; with risk on,
 * the tile's own P bound (shallowest depth, widest σ) must also be below
 * RISK_STOP_BELOW, so stopping can overstate a footprint's P by at most
 * that much and never understate it.
 */
export function canStop(w: Walk, v: NodeValues): boolean {
  if (v.dMin < w.clearAbove || (v.flags & PRECISE_FLAGS) !== 0) {
    return false;
  }
  if (!w.risk) {
    return true;
  }
  return riskAt(w, v.dMin, v.sigmaD) < RISK_STOP_BELOW;
}

/**
 * Whether descending split tile `v` could change nothing the walk has found: every leaf under it
 * is no shallower than the depths in hand, no riskier than the P in hand, no wider in σ, and
 * carries only flags and cells already folded. A split tile holds its subtree's shallowest
 * depth, widest σ and every flag (`pyramid-build.ts`, `evaluate`), so these bound each leaf, and
 * a leaf beyond the buffer counts for no more than one within it. The walk's answer is then the
 * same with the subtree left out, for any part of it the footprint reaches; only `visits` is
 * lower. A walk reading where the water is swept (`sweptOnly`) descends until it has found
 * water that is not: a split tile does not say whether all of it is swept. A subtree reaching
 * a block not loaded is descended too: the stand-in read there adds NO_COVERAGE, which no stored
 * flag bounds (invariant 3).
 */
export function addsNothing(w: Walk, v: NodeValues, z: number, x: number, y: number): boolean {
  const r = w.result;
  if (w.worst === undefined || (w.sweptOnly === true && !w.unswept)) {
    return false;
  }
  if (v.dMin < r.dMin || v.sigmaD > r.sigmaD || v.sigmaP > r.sigmaP || (v.flags & ~r.flags) !== 0) {
    return false;
  }
  // A cell not yet seen may have set a depth under the tile, unless every cell has been seen.
  const cells = w.store.cellCount;
  if (cells === undefined || w.cells.size < cells) {
    return false;
  }
  // The shallowest charted depth under the tile: unknown where part of it has no depth.
  const charted = (v.flags & FLAGS.NO_DEPTH) !== 0 ? -Infinity : v.dMin;
  if (charted < w.coveredDMin || w.store.reachesUnloaded(z, x, y)) {
    return false;
  }
  if (!w.risk) {
    return true;
  }
  // Past the threshold P rises with σ, so the widest σ bounds every leaf's; short of it a
  // leaf's P may reach 1.
  const bound = charted < w.risk.threshold ? 1 : riskAt(w, charted, v.sigmaD);
  return bound <= w.maxRisk;
}
