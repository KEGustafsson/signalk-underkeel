import type { Rect } from "../foundation/geo";
import {
  expandRect,
  groundToMercator,
  maxAbsLat,
  rectGap,
  tileRange,
  tileRect
} from "../foundation/geo";
import { normalCdf } from "../foundation/stats";
import type { NodeStore, NodeValues } from "./node-store";
import { standInCell } from "./tile-walk";

/**
 * Chart position (plan §4.3, §4.7). A charted object may lie off its drawn
 * position by the accuracy of its source: CATZOC for the survey's depths,
 * the compilation scale or QUAPOS for land, shoreline and depth areas. Depth
 * areas and lines are not widened when the pyramid is built, and neither are
 * points in assessed water, so a query carries it.
 *
 * The offset is read as a shift of the chart against the vessel, N(0, σ²)
 * per axis. A tile charted g metres beyond the footprint and its buffer then
 * lies under the footprint only if the shift towards it exceeds g, which has
 * probability Φ(−g/σ): the tile's P(UKC < 0) counts with that weight. Its
 * flags (no coverage, unassessed) count as before, within FLAG_SIGMAS·σ of
 * its survey, so a gap or an unassessed survey within reach still keeps a
 * footprint from reading as safe (invariant 4).
 *
 * Unassessed and not-for-navigation water has no survey σ and spreads no
 * depth: its flags already keep a footprint from reading as safe, and a 1 km
 * guess would fail nearly every leg near land. Its point hazards are burned
 * at the build instead (`build-items.ts`).
 */

/** Widest chart position σ modelled, metres: CATZOC D and unassessed water (2 × C). */
export const MAX_CHART_SIGMA = 500;

/**
 * A tile counts out to this many σ of its position: beyond it Φ(−z) is below
 * RISK_STOP_BELOW (`pyramid.ts`), so leaving it out understates a P by less
 * than a stopped walk may overstate one.
 */
export const REACH_SIGMAS = 3.72;

/** Flags and cell references count within this many σ of the survey, as the hard reach did. */
export const FLAG_SIGMAS = 2;

/** Chart position reach at most, metres. */
export const MAX_CHART_BUFFER = REACH_SIGMAS * MAX_CHART_SIGMA;

const capped = (sigma: number): number => Math.min(MAX_CHART_SIGMA, sigma);

/** The ground distance beyond a query buffer at which a tile placed with σ still counts, metres. */
export function chartReach(sigma: number): number {
  return sigma > 0 ? REACH_SIGMAS * capped(sigma) : 0;
}

/** The ground distance within which a tile's flags count, metres. */
export function flagReach(surveySigma: number): number {
  return surveySigma > 0 ? FLAG_SIGMAS * capped(surveySigma) : 0;
}

/**
 * Probability that a tile charted `gap` ground metres beyond the buffer lies
 * under the footprint, its position uncertain by σ: 1 within the buffer,
 * then Φ(−gap/σ). Rises with σ and falls with the gap, so a wider buffer or
 * a worse chart never lowers it (invariant 2).
 */
export function chartWeight(gap: number, sigma: number): number {
  if (gap <= 0) {
    return 1;
  }
  if (!(sigma > 0)) {
    return 0;
  }
  return normalCdf(-gap / capped(sigma));
}

/** The widest position σ of any node, over the store's coarsest nodes. */
export interface ChartSigma {
  max: number;
}

const cache = new WeakMap<NodeStore, { count: number; max: number }>();

/** The widest survey or topographic σ of the store (`NodeStore.surveySigma`, `topoSigma`). */
export function chartSigma(store: NodeStore): ChartSigma {
  const hit = cache.get(store);
  if (hit && hit.count === store.count) {
    return { max: hit.max };
  }
  let max = 0;
  for (const [, , i] of store.entries(store.minZoom)) {
    max = Math.max(max, store.surveySigma(i), store.topoSigma(i));
  }
  max = capped(max);
  cache.set(store, { count: store.count, max });
  return { max };
}

/** A pyramid cell whose chart position reaches beyond it. */
export interface Reacher {
  rect: Rect;
  /** Its values, for its flags; a stand-in's carry NO_COVERAGE. */
  values: NodeValues;
  /** The values bound finer cells (a split node cut at `maxZoom`). */
  bound: boolean;
  /** The depth its survey places (`NodeStore.bathyDMin`); Infinity when none. */
  bathyDMin: number;
  /** σ of its survey, metres; 0 when unassessed. */
  surveySigma: number;
  /** σ of what the chart's drawing places (land, depth areas), metres; 0 when none. */
  topoSigma: number;
  /** The depth the drawing places (`NodeStore.topoDMinOf`), −Infinity for land; Infinity when none. */
  topoDMin: number;
  /** Mercator metres per ground metre at the poleward edge of the reach. */
  perMetre: number;
}

/**
 * The cells, no finer than `maxZoom`, whose chart position reaches `rect`,
 * for drawing what a query anywhere in `rect` would count. A split node at
 * `maxZoom` stands for its subtree: its shallowest survey depth and its
 * widest σ bound every leaf under it.
 */
export function reachersOf(store: NodeStore, rect: Rect, maxZoom: number): Reacher[] {
  const ground = chartReach(chartSigma(store).max);
  if (ground <= 0) {
    return [];
  }
  const first = groundToMercator(ground, maxAbsLat(rect));
  const perMetre = groundToMercator(1, maxAbsLat(expandRect(rect, first)));
  const out: Reacher[] = [];
  const visit = (z: number, x: number, y: number): void => {
    const i = store.find(z, x, y);
    if (i < 0) {
      return;
    }
    const surveySigma = store.surveySigma(i);
    const topoSigma = store.topoSigma(i);
    const reach =
      perMetre * Math.max(chartReach(Math.max(surveySigma, topoSigma)), flagReach(surveySigma));
    const r = tileRect(z, x, y);
    if (reach <= 0 || rectGap(r, rect) > reach) {
      return;
    }
    const split = store.isSplit(i);
    const reacher = (values: NodeValues, bound: boolean): Reacher => ({
      rect: r,
      values,
      bound,
      bathyDMin: store.bathyDMinOf(i),
      topoDMin: store.topoDMinOf(i),
      surveySigma,
      topoSigma,
      perMetre
    });
    if (!split || z >= maxZoom) {
      out.push(reacher(store.values(i), split));
      return;
    }
    const s = store.standIn(i, z, x, y);
    if (s) {
      out.push(reacher(standInCell(store.values(i), s), true));
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
