import type { LonLat, Rect } from "../foundation/geo";
import {
  expandRect,
  fromMercator,
  groundToMercator,
  maxAbsLat,
  tileRange,
  tileRect,
  toMercator
} from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { geomBounds, geomRectDistance } from "../foundation/geometry";
import type { NodeStore, NodeValues } from "./node-store";
import { combine, EMPTY, FLAGS, NO_DATA } from "./node-store";

/**
 * `minDepthOver` (plan §4.3): the shallowest charted depth any part of a
 * footprint, widened by a ground buffer, can reach. Uniform tiles answer
 * exactly; split tiles are descended until the footprint is resolved.
 */

export interface DepthResult extends NodeValues {
  /**
   * Shallowest charted depth, leaving out tiles with no depth data at all;
   * Infinity when nothing is charted. A footprint straddling a coverage
   * edge reports dMin = -Infinity with NO_COVERAGE, and this keeps the
   * charted part's answer visible.
   */
  coveredDMin: number;
  /** The tile that set dMin, for explanations. */
  worst?: { z: number; x: number; y: number; center: LonLat };
  /** Tiles examined, for the performance budget. */
  visits: number;
}

export interface QueryOptions {
  /** Ground buffer around the footprint in metres (position uncertainty). */
  bufferMetres?: number;
  /**
   * Stop descending where a tile's lower bound is already at least this
   * deep. The bound is returned as is, so the answer stays conservative.
   */
  clearAbove?: number;
}

/** A footprint ring in WGS84, as a Mercator polygon. */
export function footprintGeom(ring: readonly LonLat[]): Geom {
  const outer = ring.map((p) => toMercator(p[0], p[1]));
  if (outer.length === 1) {
    return { type: "point", p: outer[0] as readonly [number, number] };
  }
  return { type: "polygon", polygons: [{ outer, holes: [] }] };
}

interface Walk {
  store: NodeStore;
  geom: Geom;
  buffer: number;
  clearAbove: number;
  result: NodeValues;
  coveredDMin: number;
  worst?: { z: number; x: number; y: number };
  visits: number;
}

function take(w: Walk, v: NodeValues, z: number, x: number, y: number): void {
  if (v.dMin < w.result.dMin || w.worst === undefined) {
    w.worst = { z, x, y };
  }
  w.result = combine(w.result, v);
  if ((v.flags & FLAGS.NO_DEPTH) === 0) {
    w.coveredDMin = Math.min(w.coveredDMin, v.dMin);
  }
}

function visit(w: Walk, z: number, x: number, y: number): void {
  const rect = tileRect(z, x, y);
  if (geomRectDistance(w.geom, rect, w.buffer) > w.buffer) {
    return;
  }
  w.visits++;
  const i = w.store.find(z, x, y);
  if (i < 0) {
    take(w, NO_DATA, z, x, y);
    return;
  }
  const v = w.store.values(i);
  if (!w.store.isSplit(i) || v.dMin >= w.clearAbove) {
    take(w, v, z, x, y);
    return;
  }
  visit(w, z + 1, 2 * x, 2 * y);
  visit(w, z + 1, 2 * x + 1, 2 * y);
  visit(w, z + 1, 2 * x, 2 * y + 1);
  visit(w, z + 1, 2 * x + 1, 2 * y + 1);
}

/** Mercator buffer for a ground buffer around `bounds`, sized at its poleward edge. */
export function mercatorBuffer(bounds: Rect, metres: number): number {
  const first = groundToMercator(metres, maxAbsLat(bounds));
  return groundToMercator(metres, maxAbsLat(expandRect(bounds, first)));
}

/**
 * Conservative minimum depth over `geom` widened by the ground buffer.
 * Tiles never built (outside the chart) count as NO_DATA.
 */
export function minDepthOver(store: NodeStore, geom: Geom, opts: QueryOptions = {}): DepthResult {
  const bounds = geomBounds(geom);
  const buffer = mercatorBuffer(bounds, opts.bufferMetres ?? 0);
  const w: Walk = {
    store,
    geom,
    buffer,
    clearAbove: opts.clearAbove ?? Infinity,
    result: EMPTY,
    coveredDMin: Infinity,
    visits: 0
  };
  const range = tileRange(store.minZoom, expandRect(bounds, buffer));
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      visit(w, store.minZoom, x, y);
    }
  }
  const out: DepthResult = { ...w.result, coveredDMin: w.coveredDMin, visits: w.visits };
  if (w.worst) {
    const r = tileRect(w.worst.z, w.worst.x, w.worst.y);
    out.worst = { ...w.worst, center: fromMercator((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2) };
  }
  return out;
}
