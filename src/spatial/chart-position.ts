import type { NodeStore } from "./node-store";
import { FLAGS } from "./node-store";

/**
 * Depth areas and lines are not widened by their survey's position
 * uncertainty when the pyramid is built (only point hazards are burned),
 * so a query carries it (plan §4.3, §4.7): a tile counts when it lies
 * within the query buffer plus k·σP of its own survey. Unassessed and
 * not-for-navigation water adds nothing: its flags already keep a
 * footprint from reading as safe (invariant 4), and a 1 km guess would
 * fail nearly every leg near land.
 */

/** Chart position reach at most, metres: k·σP of an unassessed survey. */
export const MAX_CHART_BUFFER = 1000;

/** Tiles whose σP is no survey's position accuracy: they leave a footprint unchecked anyway. */
export const UNSURVEYED = FLAGS.UNASSESSED | FLAGS.NOT_FOR_NAVIGATION;

/** The ground reach k·σP adds to a query buffer, metres. */
export function chartReach(k: number, sigmaP: number): number {
  return Math.min(MAX_CHART_BUFFER, k * sigmaP);
}

export interface SurveySigmaP {
  /** Per node: the widest σP of the assessed leaves under it (its own, for a leaf). */
  node: Float32Array;
  /** The widest over the whole store. */
  max: number;
}

const cache = new WeakMap<NodeStore, { count: number; sigma: SurveySigmaP }>();

/**
 * A split node's σP is the widest of all its leaves, unassessed ones
 * included, so it would bound the reach by their configured guess. This
 * column bounds it by the assessed leaves only, which keeps pruning a
 * subtree exact for the reach its leaves get. Built once per store, deepest
 * zoom first so every child is done before its parent.
 */
export function surveySigmaP(store: NodeStore): SurveySigmaP {
  const hit = cache.get(store);
  if (hit && hit.count === store.count) {
    return hit.sigma;
  }
  const node = new Float32Array(store.count);
  let max = 0;
  for (let z = store.leafZoom; z >= store.minZoom; z--) {
    for (const [x, y, i] of store.entries(z)) {
      let s = 0;
      if (!store.isSplit(i)) {
        s = ((store.flags[i] as number) & UNSURVEYED) === 0 ? (store.sigmaP[i] as number) : 0;
      } else {
        for (const [dx, dy] of CHILDREN) {
          const c = store.find(z + 1, 2 * x + dx, 2 * y + dy);
          s = Math.max(s, c < 0 ? 0 : (node[c] as number));
        }
      }
      node[i] = s;
      max = Math.max(max, s);
    }
  }
  const sigma = { node, max };
  cache.set(store, { count: store.count, sigma });
  return sigma;
}

const CHILDREN = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1]
] as const;
