import type { LonLat, Rect, XY } from "../foundation/geo";
import {
  expandRect,
  fromMercator,
  groundToMercator,
  maxAbsLat,
  rectContainsRect,
  rectGap,
  shiftRect,
  tileKey,
  tileRange,
  tileRect,
  tileRectInto,
  toMercator,
  worldShifts
} from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import {
  geomBounds,
  geomRectDistance,
  pointRectDistance,
  rectWithin,
  shiftGeom
} from "../foundation/geometry";
import type { NodeStore, NodeValues, StandIn } from "./node-store";
import { probabilityBelowZero } from "../foundation/stats";
import { EMPTY, FLAGS, NO_DATA } from "./node-store";
import type { SurveySigmaP } from "./chart-position";
import { chartReach, surveySigmaP } from "./chart-position";

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
  /**
   * Also count a tile within k·σP of its own survey beyond the buffer, for
   * the chart's position uncertainty (`chart-position.ts`); 0 by default.
   */
  chartReachK?: number;
  /**
   * Stop the walk once it has found charted land at P = 1 (needs `risk`):
   * no later tile can then change dMin, coveredDMin, maxRisk, riskTile or
   * worst. flags, σ and cellRefs then hold only the tiles visited, so a
   * gap or an unassessed survey elsewhere in reach can go unreported; the
   * look-ahead reads such a footprint again in full where its coverage
   * decides the state. Route checks never set it.
   */
  stopWhenCertain?: boolean;
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
  /** Bounds of `geom`, and a point of it when it has one. */
  bounds: Rect;
  /** `bounds` grown by `buffer`: every tile within the buffer of the footprint lies in it. */
  hold: Rect;
  vertex?: XY;
  /** Mercator reach of a tile without chart position, and of any tile at most. */
  buffer: number;
  maxReach: number;
  /** Mercator metres per ground metre of chart reach. */
  perMetre: number;
  k: number;
  survey?: SurveySigmaP;
  clearAbove: number;
  /** Folded in place by `take`; never one of the shared constants. */
  result: NodeValues;
  /** Scratch bounds of the tile being visited. */
  rect: Rect;
  coveredDMin: number;
  cells: Set<number>;
  worst?: { z: number; x: number; y: number };
  visits: number;
  risk?: { threshold: number; sigmaExtra: number };
  maxRisk: number;
  riskTile?: { v: NodeValues; z: number; x: number; y: number; risk: number };
  stopWhenCertain: boolean;
}

/** Folds a tile's depth, σ, flags and cell into the result. */
function fold(w: Walk, v: NodeValues, flags: number, z: number, x: number, y: number): void {
  const r = w.result;
  if (v.dMin < r.dMin || w.worst === undefined) {
    w.worst = { z, x, y };
  }
  // combine() folded in place: a tick takes thousands of tiles.
  if (v.dMin < r.dMin) {
    r.dMin = v.dMin;
    r.cellRef = v.cellRef;
  }
  r.sigmaD = Math.max(r.sigmaD, v.sigmaD);
  r.sigmaP = Math.max(r.sigmaP, v.sigmaP);
  r.flags |= flags;
  if (v.cellRef >= 0) {
    w.cells.add(v.cellRef);
  }
}

/** Counts a charted tile's P(UKC < 0) from its dMin and σD. */
function weigh(w: Walk, t: NodeValues, z: number, x: number, y: number): void {
  if (w.risk) {
    const sigma = Math.hypot(t.sigmaD, w.risk.sigmaExtra);
    const risk = probabilityBelowZero(t.dMin - w.risk.threshold, sigma);
    if (w.riskTile === undefined || risk > w.riskTile.risk) {
      w.riskTile = { v: t, z, x, y, risk };
      w.maxRisk = risk;
    }
  }
}

function take(w: Walk, v: NodeValues, z: number, x: number, y: number): void {
  fold(w, v, v.flags, z, x, y);
  if ((v.flags & FLAGS.NO_DEPTH) === 0) {
    w.coveredDMin = Math.min(w.coveredDMin, v.dMin);
    weigh(w, v, z, x, y);
  }
}

/**
 * Takes a split tile whose children are in a block not loaded, as no
 * coverage and with bounds no loaded child could exceed: its own shallowest
 * depth, widest σ and flags, the shallowest charted depth under it, and a
 * risk at least any charted child's. Below the threshold a child's P is
 * highest at its least σ, above it at its widest, so the stand-in's σ is
 * picked by the side its charted depth is on.
 */
function takeStandIn(w: Walk, v: NodeValues, s: StandIn, z: number, x: number, y: number): void {
  const flags = v.flags | FLAGS.NO_COVERAGE;
  fold(w, v, flags, z, x, y);
  if (s.covered === Infinity) {
    return;
  }
  w.coveredDMin = Math.min(w.coveredDMin, s.covered);
  const below = w.risk !== undefined && s.covered < w.risk.threshold;
  weigh(w, { ...v, dMin: s.covered, sigmaD: below ? s.sigmaDMin : v.sigmaD, flags }, z, x, y);
}

/**
 * A split tile's flags are the union of its children's, so stopping early
 * at one carrying these would report a gap or an unassessed survey that
 * the footprint itself may not touch. Such tiles are always descended.
 */
const PRECISE_FLAGS =
  FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

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

/**
 * Every reach is widened by this factor, so a distance that rounds 1 ulp
 * above its exact value still counts and the walk stays conservative.
 */
export const REACH_SLACK = 1 + 1e-12;

/** Mercator distance at which node i still counts; a split node's bounds its subtree's. */
function reachOf(w: Walk, i: number): number {
  if (!w.survey || i < 0) {
    return w.buffer;
  }
  return w.buffer + w.perMetre * chartReach(w.k, w.store.surveySigma(i));
}

function certain(w: Walk): boolean {
  return w.maxRisk >= 1 && w.coveredDMin === -Infinity && w.result.dMin === -Infinity;
}

/** Whether tile `rect` (node i) lies within its reach of the footprint. */
function reaches(w: Walk, rect: Rect, i: number): boolean {
  // The gap to the footprint's bounds never exceeds the distance to the
  // footprint, and costs far less to find.
  const gap = rectGap(w.bounds, rect);
  if (gap > w.maxReach) {
    return false;
  }
  const reach = reachOf(w, i);
  if (gap > reach) {
    return false;
  }
  // A point of the footprint within reach settles it; most tiles inside a
  // wide chart reach are settled so.
  const close = w.vertex !== undefined && pointRectDistance(w.vertex, rect) <= reach;
  return close || geomRectDistance(w.geom, rect, reach) <= reach;
}

/**
 * `inside`: the tile lies wholly within `w.buffer`, the least reach any
 * node gets, of the footprint, so it and every tile under it are in reach
 * without testing.
 */
function visit(w: Walk, z: number, x: number, y: number, inside: boolean): void {
  if (w.stopWhenCertain && certain(w)) {
    return;
  }
  // Read before the children are visited, which overwrite it.
  const rect = tileRectInto(z, x, y, w.rect);
  const i = w.store.find(z, x, y);
  if (!inside && !reaches(w, rect, i)) {
    return;
  }
  w.visits++;
  if (i < 0) {
    take(w, NO_DATA, z, x, y);
    return;
  }
  const v = w.store.values(i);
  if (!w.store.isSplit(i) || canStop(w, v)) {
    take(w, v, z, x, y);
    return;
  }
  const s = w.store.standIn(i, z, x, y);
  if (s) {
    takeStandIn(w, v, s, z, x, y);
    return;
  }
  // Only a tile inside the footprint's bounds grown by the buffer can lie within the buffer.
  const within = inside || (rectContainsRect(w.hold, rect) && rectWithin(w.geom, rect, w.buffer));
  visit(w, z + 1, 2 * x, 2 * y, within);
  visit(w, z + 1, 2 * x + 1, 2 * y, within);
  visit(w, z + 1, 2 * x, 2 * y + 1, within);
  visit(w, z + 1, 2 * x + 1, 2 * y + 1, within);
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

function vertexOf(g: Geom): XY | undefined {
  return g.type === "point" ? g.p : g.type === "line" ? g.coords[0] : g.polygons[0]?.outer[0];
}

/** Mercator buffer for a ground buffer around `bounds`, sized at its poleward edge. */
export function mercatorBuffer(bounds: Rect, metres: number): number {
  const first = groundToMercator(metres, maxAbsLat(bounds));
  return groundToMercator(metres, maxAbsLat(expandRect(bounds, first)));
}

function walkFor(store: NodeStore, geom: Geom, opts: QueryOptions): Walk {
  const bounds = geomBounds(geom);
  const bufferMetres = opts.bufferMetres ?? 0;
  const k = opts.chartReachK ?? 0;
  const survey = k > 0 ? surveySigmaP(store) : undefined;
  // Sized for the widest reach, so every narrower one is converted at a
  // latitude at least as far poleward as its own edge.
  const ground = bufferMetres + (survey ? chartReach(k, survey.max) : 0);
  const maxReach = mercatorBuffer(bounds, ground) * REACH_SLACK;
  const perMetre = ground > 0 ? maxReach / ground : 0;
  // Stopping early is only conservative for risk where the bound is at or
  // past the threshold: there P rises with σ, so the parent's widest σ
  // bounds every child's P from above.
  const clearAbove = Math.max(
    opts.clearAbove ?? (opts.risk ? -Infinity : Infinity),
    opts.risk?.threshold ?? -Infinity
  );
  return {
    store,
    geom,
    bounds,
    hold: bounds,
    buffer: survey ? perMetre * bufferMetres : maxReach,
    maxReach,
    perMetre,
    k,
    survey,
    clearAbove,
    risk: opts.risk,
    maxRisk: 0,
    stopWhenCertain: opts.stopWhenCertain === true,
    result: { ...EMPTY },
    rect: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    coveredDMin: Infinity,
    cells: new Set(),
    visits: 0
  };
}

/**
 * Conservative minimum depth over `geom` widened by the ground buffer, and
 * with `chartReachK` by each tile's chart position reach.
 * Tiles never built (outside the chart) count as NO_DATA. A footprint or
 * buffer reaching past ±180° is also walked one world over, so the tiles
 * at the other end of the world count too.
 */
export function minDepthOver(store: NodeStore, geom: Geom, opts: QueryOptions = {}): DepthResult {
  const w = walkFor(store, geom, opts);
  const bounds = w.bounds;
  const reach = expandRect(bounds, w.maxReach);
  for (const shift of worldShifts(reach)) {
    w.geom = shift === 0 ? geom : shiftGeom(geom, shift);
    w.bounds = shiftRect(bounds, shift);
    w.hold = expandRect(w.bounds, w.buffer);
    w.vertex = vertexOf(w.geom);
    const shifted = shiftRect(reach, shift);
    const range = tileRange(store.minZoom, shifted);
    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        visit(w, store.minZoom, x, y, false);
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
    maxRisk: w.maxRisk
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
