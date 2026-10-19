import type { LonLat, Rect } from "../foundation/geo";
import {
  expandRect,
  fromMercator,
  groundToMercator,
  maxAbsLat,
  shiftRect,
  tileKey,
  tileRange,
  tileRect,
  toMercator,
  worldShifts
} from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { geomBounds, geomRectDistance, shiftGeom } from "../foundation/geometry";
import type { NodeStore, NodeValues } from "./node-store";
import { probabilityBelowZero } from "../foundation/stats";
import { combine, EMPTY, FLAGS, NO_DATA } from "./node-store";

/**
 * `minDepthOver` (plan §4.3): the shallowest charted depth any part of a
 * footprint, widened by a ground buffer, can reach. Uniform tiles answer
 * exactly; split tiles are descended until the footprint is resolved.
 */

/** The tile with the highest P(UKC < 0) and the values that gave it. */
export interface RiskTile extends NodeValues {
  risk: number;
  center: LonLat;
}

export interface DepthResult extends NodeValues {
  /**
   * Shallowest charted depth, leaving out tiles with no depth data at all;
   * Infinity when nothing is charted. A footprint straddling a coverage
   * edge reports dMin = -Infinity with NO_COVERAGE, and this keeps the
   * charted part's answer visible.
   */
  coveredDMin: number;
  /** Catalogue indices of the cells that set each examined tile's depth. */
  cellRefs: number[];
  /** The tile that set dMin, for explanations. */
  worst?: { z: number; x: number; y: number; center: LonLat };
  /** Tiles examined, for the performance budget. */
  visits: number;
  /** With `risk` set: the highest per-tile P(UKC < 0) over charted tiles, else 0. */
  maxRisk: number;
  riskTile?: RiskTile;
  /**
   * The widest σP of the assessed tiles taken at their own resolution.
   * `sigmaP` also holds split tiles the walk stopped at, whose children's
   * widest σP may come from a survey the footprint does not reach, and
   * unassessed tiles, whose σP is the configured guess, not a survey's.
   */
  surveySigmaP: number;
}

export interface QueryOptions {
  /** Ground buffer around the footprint in metres (position uncertainty). */
  bufferMetres?: number;
  /**
   * Stop descending where a tile's lower bound is already at least this
   * deep and the tile carries no coverage or assessment flags. The bound is
   * returned as is, so the answer stays conservative.
   */
  clearAbove?: number;
  /**
   * Also compute P(UKC < 0) per charted tile: UKC ~ N(dMin − threshold,
   * sigmaD² + sigmaExtra²). The footprint's risk is the highest tile's,
   * so a wider footprint or buffer can only add tiles and never lower it.
   */
  risk?: { threshold: number; sigmaExtra: number };
  /** Leave living-chart adjustments out, to read the chart alone. */
  chartOnly?: boolean;
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
  cells: Set<number>;
  worst?: { z: number; x: number; y: number };
  visits: number;
  risk?: { threshold: number; sigmaExtra: number };
  maxRisk: number;
  riskTile?: { v: NodeValues; z: number; x: number; y: number; risk: number };
  surveySigmaP: number;
}

function take(w: Walk, v: NodeValues, z: number, x: number, y: number): void {
  if (v.dMin < w.result.dMin || w.worst === undefined) {
    w.worst = { z, x, y };
  }
  w.result = combine(w.result, v);
  if ((v.flags & FLAGS.NO_DEPTH) === 0) {
    w.coveredDMin = Math.min(w.coveredDMin, v.dMin);
  }
  if (v.cellRef >= 0) {
    w.cells.add(v.cellRef);
  }
  if (w.risk && (v.flags & FLAGS.NO_DEPTH) === 0) {
    const sigma = Math.hypot(v.sigmaD, w.risk.sigmaExtra);
    const risk = probabilityBelowZero(v.dMin - w.risk.threshold, sigma);
    if (w.riskTile === undefined || risk > w.riskTile.risk) {
      w.riskTile = { v, z, x, y, risk };
      w.maxRisk = risk;
    }
  }
}

/**
 * A split tile's flags are the union of its children's, so stopping early
 * at one carrying these would report a gap or an unassessed survey that
 * the footprint itself may not touch. Such tiles are always descended.
 */
const PRECISE_FLAGS =
  FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

/** Tiles whose σP is no survey's position accuracy: they leave a footprint unchecked anyway. */
const UNSURVEYED = FLAGS.UNASSESSED | FLAGS.NOT_FOR_NAVIGATION;

/** Below this, a split tile's risk bound is negligible and its children need not be visited. */
export const RISK_STOP_BELOW = 1e-4;

/**
 * Whether a split tile may answer for its children. Its bound must clear
 * `clearAbove` and carry no coverage or assessment flags; with risk on,
 * the tile's own P bound (shallowest depth, widest σ) must also be below
 * RISK_STOP_BELOW, so stopping can overstate a footprint's P by at most
 * that much and never understate it.
 */
function canStop(w: Walk, v: NodeValues): boolean {
  if (v.dMin < w.clearAbove || (v.flags & PRECISE_FLAGS) !== 0) {
    return false;
  }
  if (!w.risk) {
    return true;
  }
  const sigma = Math.hypot(v.sigmaD, w.risk.sigmaExtra);
  return probabilityBelowZero(v.dMin - w.risk.threshold, sigma) < RISK_STOP_BELOW;
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
  const split = w.store.isSplit(i);
  if (!split || canStop(w, v)) {
    take(w, v, z, x, y);
    if (!split && (v.flags & UNSURVEYED) === 0) {
      w.surveySigmaP = Math.max(w.surveySigmaP, v.sigmaP);
    }
    return;
  }
  visit(w, z + 1, 2 * x, 2 * y);
  visit(w, z + 1, 2 * x + 1, 2 * y);
  visit(w, z + 1, 2 * x, 2 * y + 1);
  visit(w, z + 1, 2 * x + 1, 2 * y + 1);
}

/** Living-chart cells near the footprint are taken beside the charted tiles. */
function takeAdjustments(w: Walk, reach: Rect): void {
  const adj = w.store.adjustments;
  if (adj.size === 0) {
    return;
  }
  const z = w.store.adjustZoom;
  const range = tileRange(z, reach);
  const consider = (x: number, y: number, v: NodeValues): void => {
    if (geomRectDistance(w.geom, tileRect(z, x, y), w.buffer) <= w.buffer) {
      take(w, v, z, x, y);
    }
  };
  const tiles = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
  if (tiles <= adj.size) {
    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        const v = adj.get(tileKey(z, x, y));
        if (v) {
          consider(x, y, v);
        }
      }
    }
    return;
  }
  const n = 2 ** z;
  for (const [key, v] of adj) {
    const x = Math.floor(key / n);
    const y = key % n;
    if (x >= range.minX && x <= range.maxX && y >= range.minY && y <= range.maxY) {
      consider(x, y, v);
    }
  }
}

/** Mercator buffer for a ground buffer around `bounds`, sized at its poleward edge. */
export function mercatorBuffer(bounds: Rect, metres: number): number {
  const first = groundToMercator(metres, maxAbsLat(bounds));
  return groundToMercator(metres, maxAbsLat(expandRect(bounds, first)));
}

/**
 * Conservative minimum depth over `geom` widened by the ground buffer.
 * Tiles never built (outside the chart) count as NO_DATA. A footprint or
 * buffer reaching past ±180° is also walked one world over, so the tiles
 * at the other end of the world count too.
 */
export function minDepthOver(store: NodeStore, geom: Geom, opts: QueryOptions = {}): DepthResult {
  const bounds = geomBounds(geom);
  const buffer = mercatorBuffer(bounds, opts.bufferMetres ?? 0);
  // Stopping early is only conservative for risk where the bound is at or
  // past the threshold: there P rises with σ, so the parent's widest σ
  // bounds every child's P from above.
  const clearAbove = Math.max(
    opts.clearAbove ?? (opts.risk ? -Infinity : Infinity),
    opts.risk?.threshold ?? -Infinity
  );
  const w: Walk = {
    store,
    geom,
    buffer,
    clearAbove,
    risk: opts.risk,
    maxRisk: 0,
    surveySigmaP: 0,
    result: EMPTY,
    coveredDMin: Infinity,
    cells: new Set(),
    visits: 0
  };
  const reach = expandRect(bounds, buffer);
  for (const shift of worldShifts(reach)) {
    w.geom = shift === 0 ? geom : shiftGeom(geom, shift);
    const shifted = shiftRect(reach, shift);
    const range = tileRange(store.minZoom, shifted);
    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        visit(w, store.minZoom, x, y);
      }
    }
    if (!opts.chartOnly) {
      takeAdjustments(w, shifted);
    }
  }
  const out: DepthResult = {
    ...w.result,
    coveredDMin: w.coveredDMin,
    cellRefs: [...w.cells].sort((a, b) => a - b),
    visits: w.visits,
    maxRisk: w.maxRisk,
    surveySigmaP: w.surveySigmaP
  };
  if (w.riskTile) {
    const t = w.riskTile;
    const r = tileRect(t.z, t.x, t.y);
    out.riskTile = {
      ...t.v,
      risk: t.risk,
      center: fromMercator((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2)
    };
  }
  if (w.worst) {
    const r = tileRect(w.worst.z, w.worst.x, w.worst.y);
    out.worst = { ...w.worst, center: fromMercator((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2) };
  }
  return out;
}
