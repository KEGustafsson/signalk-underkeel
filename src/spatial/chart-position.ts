import type { Rect } from "../foundation/geo";
import {
  expandRect,
  groundToMercator,
  maxAbsLat,
  rectGap,
  tileRange,
  tileRect
} from "../foundation/geo";
import type { NodeStore, NodeValues } from "./node-store";

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

/** The ground reach k·σP adds to a query buffer, metres. */
export function chartReach(k: number, sigmaP: number): number {
  return Math.min(MAX_CHART_BUFFER, k * sigmaP);
}

export interface SurveySigmaP {
  /** Per node: the widest assessed σP reaching it or any leaf under it. */
  node: Float32Array;
  /** The widest over the whole store. */
  max: number;
}

const cache = new WeakMap<NodeStore, { count: number; max: number }>();

/** The store's assessed survey σP column (`NodeStore.surveySigmaP`) and its widest value. */
export function surveySigmaP(store: NodeStore): SurveySigmaP {
  const hit = cache.get(store);
  if (hit && hit.count === store.count) {
    return { node: store.surveySigmaP, max: hit.max };
  }
  let max = 0;
  for (const [, , i] of store.entries(store.minZoom)) {
    max = Math.max(max, store.surveySigmaP[i] as number);
  }
  cache.set(store, { count: store.count, max });
  return { node: store.surveySigmaP, max };
}

/** A pyramid cell whose chart reach extends beyond it. */
export interface Reacher {
  rect: Rect;
  values: NodeValues;
  /** The values bound finer cells (a split node cut at `maxZoom`). */
  bound: boolean;
  /** k·σP of its assessed survey, in Mercator metres at the poleward edge of the reach. */
  reach: number;
}

/**
 * The cells, no finer than `maxZoom`, whose chart reach k·σP touches
 * `rect`, for drawing what a query anywhere in `rect` would count. A split
 * node at `maxZoom` stands for its subtree with its bound and its widest
 * assessed σP; a subtree with no assessed survey reaches nothing.
 */
export function reachersOf(store: NodeStore, rect: Rect, k: number, maxZoom: number): Reacher[] {
  const sigma = surveySigmaP(store);
  const ground = chartReach(k, sigma.max);
  if (ground <= 0) {
    return [];
  }
  const first = groundToMercator(ground, maxAbsLat(rect));
  const perMetre = groundToMercator(1, maxAbsLat(expandRect(rect, first)));
  const out: Reacher[] = [];
  const visit = (z: number, x: number, y: number): void => {
    const i = store.find(z, x, y);
    const reach = i < 0 ? 0 : perMetre * chartReach(k, sigma.node[i] as number);
    const r = tileRect(z, x, y);
    if (reach <= 0 || rectGap(r, rect) > reach) {
      return;
    }
    const split = store.isSplit(i);
    if (!split || z >= maxZoom) {
      out.push({ rect: r, values: store.values(i), bound: split, reach });
      return;
    }
    for (const [dx, dy] of CHILDREN) {
      visit(z + 1, 2 * x + dx, 2 * y + dy);
    }
  };
  const range = tileRange(store.minZoom, expandRect(rect, perMetre * ground));
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      visit(store.minZoom, x, y);
    }
  }
  return out;
}

const CHILDREN = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1]
] as const;
