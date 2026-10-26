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
  tileSize,
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
import type { NodeStore, NodeValues } from "./node-store";
import { EMPTY, FLAGS, NO_DATA } from "./node-store";
import type { Walk } from "./walk";
import { certain, foldFlags, REACH_FLAGS, riskAt, take, takeStandIn } from "./walk";
import { chartReach, chartSigma, flagReach, MAX_CHART_SIGMA } from "./chart-position";
import { flagsShadowed, shadedWeight, shadowFor } from "./survey-shadow";

/**
 * `minDepthOver` (plan §4.3): the shallowest charted depth any part of a
 * footprint, widened by a ground buffer, can reach. Uniform tiles answer
 * exactly; split tiles are descended until the footprint is resolved.
 */

/** How a tile beyond the buffer counted, by its chart position (`chart-position.ts`). */
export interface ChartReach {
  /** Ground metres from the buffer's edge to the tile. */
  distance: number;
  /** σ of the position that placed it, metres. */
  sigmaP: number;
  /** Φ(−distance/σP): the chance it lies under the footprint. */
  weight: number;
  /** Placed by its survey (CATZOC) or by its land and shoreline objects' own accuracy. */
  source: "survey" | "topography";
  /** Ground metres across the tile's diagonal: what it stands for lies within it. */
  extent: number;
  /**
   * Set when the water charted closer to the footprint bounds the weight
   * below Φ(−distance/σP) (survey shadow, `survey-shadow.ts`): the weight is
   * then Φ(−distance/σP) of this water instead.
   */
  shadow?: { distance: number; sigmaP: number };
}

/** The tile with the highest P(UKC < 0) and the values that gave it. */
export interface RiskTile extends NodeValues {
  /** P(UKC < 0), times `chart.weight` for a tile beyond the buffer. */
  risk: number;
  center: LonLat;
  /** Set for a tile beyond the buffer; dMin is then the depth it spreads. */
  chart?: ChartReach;
}

export interface DepthResult extends NodeValues {
  /**
   * Shallowest charted depth, leaving out tiles with no depth data at all;
   * Infinity when nothing is charted. A footprint straddling a coverage
   * edge reports dMin = -Infinity with NO_COVERAGE, and this keeps the
   * charted part's answer visible. Like dMin, it reads the tiles within the
   * buffer only: a tile beyond it counts by its weighted P.
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
   * Also count tiles beyond the buffer by the chart's position uncertainty
   * (`chart-position.ts`): with `risk`, a tile's P(UKC < 0) times the chance
   * the chart is off by its distance; its flags and cell within
   * FLAG_SIGMAS·σP of its survey.
   */
  chartPosition?: boolean;
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

/**
 * A split tile's flags are the union of its children's, so stopping early
 * at one carrying these would report a gap or an unassessed survey that
 * the footprint itself may not touch. Such tiles are always descended.
 */
const PRECISE_FLAGS = REACH_FLAGS;

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
  return riskAt(w, v.dMin, v.sigmaD) < RISK_STOP_BELOW;
}

/**
 * Every reach is widened by this factor, so a distance that rounds 1 ulp
 * above its exact value still counts and the walk stays conservative.
 */
export const REACH_SLACK = 1 + 1e-12;

/** Mercator distance at which node i still counts; a split node's bounds its subtree's. */
function reachOf(w: Walk, i: number): number {
  if (!w.graded || i < 0) {
    return w.buffer;
  }
  const survey = w.store.surveySigma(i);
  const ground = Math.max(chartReach(Math.max(survey, w.store.topoSigma(i))), flagReach(survey));
  return w.reachBase + w.perMetre * ground;
}

/**
 * The Mercator distance from the footprint to tile `rect` when it is within
 * `reach`, else Infinity. A distance at most `w.buffer` may come back as
 * any value at most `w.buffer`: within the buffer it only matters that it is.
 */
function distanceTo(w: Walk, rect: Rect, reach: number): number {
  // The gap to the footprint's bounds never exceeds the distance to the
  // footprint, and costs far less to find.
  if (rectGap(w.bounds, rect) > reach) {
    return Infinity;
  }
  if (w.vertex !== undefined) {
    const d = pointRectDistance(w.vertex, rect);
    if (d <= w.buffer) {
      return d;
    }
  }
  return geomRectDistance(w.geom, rect, reach);
}

/**
 * P(UKC < 0) at most of the survey depth `bathy` under node i with σD
 * `sigmaD`. A split node's bathy is its subtree's shallowest and its σD the
 * widest: past the threshold P rises with σ and is bounded so, short of it
 * a child's P may reach 1.
 */
function bathyRisk(w: Walk, bathy: number, sigmaD: number, bound: boolean): number {
  const r = w.risk as { threshold: number; sigmaExtra: number };
  if (bound && bathy < r.threshold) {
    return 1;
  }
  return riskAt(w, bathy, sigmaD);
}

/** Whether node i's flags reach the footprint from `ground` metres beyond the buffer. */
function flagsReach(w: Walk, i: number, ground: number): boolean {
  return ground <= flagReach(w.store.surveySigma(i)) && !flagsShadowed(w.shadow, ground);
}

/**
 * The weighted P a tile beyond the buffer adds, `ground` metres past it:
 * its survey depth's P times the chance its survey is off that far, or its
 * drawn depth's (land, depth areas) times the chance the drawing is. Exact
 * for a leaf, a bound for a split node.
 */
function reachRisk(
  w: Walk,
  i: number,
  v: NodeValues,
  ground: number,
  bound: boolean
): { risk: number; chart: Omit<ChartReach, "extent">; dMin: number } | undefined {
  const survey = w.store.surveySigma(i);
  const topo = w.store.topoSigma(i);
  // The survey depth is never shallower than dMin, the least of every depth under the node,
  // but it is stored as a float32 rounded shallower and could read one ulp under dMin: a
  // tile just past the buffer would then read a higher P than within it.
  const bathy = Math.max(w.store.bathyDMinOf(i), v.dMin);
  let best: { risk: number; chart: Omit<ChartReach, "extent">; dMin: number } | undefined;
  // The shadow is only searched for a P that could raise the footprint's, past
  // RISK_STOP_BELOW or the P found so far, as the walk only stops below one.
  const floor = Math.max(w.maxRisk, RISK_STOP_BELOW);
  // A split node's flags hold NO_DEPTH when any leaf under it has no depth;
  // its bathyDMin is Infinity only when none has any.
  if (survey > 0 && bathy !== Infinity) {
    const p = bathyRisk(w, bathy, v.sigmaD, bound);
    const { risk, weight, shadow } = shadedWeight(w.shadow, ground, survey, p, floor);
    best = {
      risk,
      dMin: bathy,
      // The σ the weight used: chartWeight caps it at MAX_CHART_SIGMA.
      chart: {
        distance: ground,
        sigmaP: Math.min(MAX_CHART_SIGMA, survey),
        weight,
        source: "survey",
        ...(shadow && { shadow })
      }
    };
  }
  // Land reads −Infinity, which v.dMin then is too; float32 rounding as for the survey depth.
  const drawn = Math.max(w.store.topoDMinOf(i), v.dMin);
  if (topo > 0 && drawn !== Infinity) {
    const p = bathyRisk(w, drawn, v.sigmaD, bound);
    const { risk, weight, shadow } = shadedWeight(w.shadow, ground, topo, p, floor);
    if (!best || risk > best.risk) {
      best = {
        risk,
        dMin: drawn,
        chart: {
          distance: ground,
          sigmaP: Math.min(MAX_CHART_SIGMA, topo),
          weight,
          source: "topography",
          ...(shadow && { shadow })
        }
      };
    }
  }
  return best;
}

/** Counts a leaf, or a stand-in, beyond the buffer by its chart position. */
function takeBeyond(
  w: Walk,
  i: number,
  v: NodeValues,
  flags: number,
  ground: number,
  bound: boolean,
  z: number,
  x: number,
  y: number
): void {
  if (flagsReach(w, i, ground)) {
    foldFlags(w, v, flags);
  }
  if (!w.risk) {
    return;
  }
  const r = reachRisk(w, i, v, ground, bound);
  if (r && (w.riskTile === undefined || r.risk > w.riskTile.risk)) {
    const sigmaD = r.chart.source === "topography" && r.dMin === -Infinity ? 0 : v.sigmaD;
    w.riskTile = {
      v: { ...v, dMin: r.dMin, sigmaD, flags },
      z,
      x,
      y,
      risk: r.risk,
      chart: r.chart
    };
    w.maxRisk = r.risk;
  }
}

/**
 * A tile beyond the buffer: its flags count within its survey's flag reach,
 * its P weighted by its chart position. A split tile is descended unless
 * its weighted bound cannot raise the footprint's P and its flags, if they
 * count, need no locating.
 */
function visitBeyond(w: Walk, i: number, ground: number, z: number, x: number, y: number): void {
  const v = w.store.values(i);
  if (!w.store.isSplit(i)) {
    takeBeyond(w, i, v, v.flags, ground, false, z, x, y);
    return;
  }
  const inFlags = flagsReach(w, i, ground);
  const bound = w.risk ? (reachRisk(w, i, v, ground, true)?.risk ?? 0) : 0;
  const settled = bound <= Math.max(w.maxRisk, RISK_STOP_BELOW);
  if (settled && (!inFlags || (v.flags & PRECISE_FLAGS) === 0)) {
    if (inFlags) {
      foldFlags(w, v, v.flags);
    }
    return;
  }
  const s = w.store.standIn(i, z, x, y);
  if (s) {
    takeBeyond(w, i, v, v.flags | FLAGS.NO_COVERAGE, ground, true, z, x, y);
    return;
  }
  visit(w, z + 1, 2 * x, 2 * y, false);
  visit(w, z + 1, 2 * x + 1, 2 * y, false);
  visit(w, z + 1, 2 * x, 2 * y + 1, false);
  visit(w, z + 1, 2 * x + 1, 2 * y + 1, false);
}

/**
 * A tile not known to lie within the buffer: false when it lies beyond it
 * and has been counted there (or out of reach), true when it lies within.
 * Beyond the buffer the distance is ground metres past it at the reach's
 * poleward edge, at least 0: never more than the true distance, so the
 * weight is never less (invariant 2).
 */
function takeOutside(w: Walk, i: number, rect: Rect, z: number, x: number, y: number): boolean {
  const gap = rectGap(w.bounds, rect);
  const reach = reachOf(w, i);
  if (gap > reach || negligible(w, i, gap)) {
    return false;
  }
  const d = distanceTo(w, rect, reach);
  if (d <= w.buffer) {
    return true;
  }
  if (d <= reach) {
    w.visits++;
    visitBeyond(w, i, Math.max(0, (d - w.reachBase) / w.perMetre), z, x, y);
  }
  return false;
}

/**
 * Whether node i can be left out without measuring its distance: the gap to
 * the footprint's bounds is no more than the distance, and a nearer tile
 * only weighs more, so if even at that gap its flags lie out of reach and
 * its risk bound cannot raise the footprint's P (past RISK_STOP_BELOW), the
 * exact distance would leave it out too.
 */
function negligible(w: Walk, i: number, gap: number): boolean {
  if (!w.graded || i < 0) {
    return false;
  }
  if (gap <= w.reachBase) {
    return false;
  }
  const ground = (gap - w.reachBase) / w.perMetre;
  if (flagsReach(w, i, ground)) {
    return false;
  }
  if (!w.risk) {
    return true;
  }
  const bound = reachRisk(w, i, w.store.values(i), ground, w.store.isSplit(i))?.risk ?? 0;
  return bound <= Math.max(w.maxRisk, RISK_STOP_BELOW);
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
  if (!inside && !takeOutside(w, i, rect, z, x, y)) {
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
  const graded = opts.chartPosition === true && chartSigma(store).max > 0;
  // Sized for the widest reach, so every narrower one is converted at a
  // latitude at least as far poleward as its own edge.
  const ground = bufferMetres + (graded ? chartReach(chartSigma(store).max) : 0);
  const maxReach = mercatorBuffer(bounds, ground) * REACH_SLACK;
  const perMetre = ground > 0 ? maxReach / ground : 0;
  // Stopping early is only conservative for risk where the bound is at or
  // past the threshold: there P rises with σ, so the parent's widest σ
  // bounds every child's P from above.
  const clearAbove = Math.max(
    opts.clearAbove ?? (opts.risk ? -Infinity : Infinity),
    opts.risk?.threshold ?? -Infinity
  );
  const reachBase = graded ? perMetre * bufferMetres : maxReach;
  const toGround = (d: number): number => Math.max(0, (d - reachBase) / perMetre);
  return {
    store,
    geom,
    bounds,
    hold: bounds,
    // The plain walk's buffer, so the tiles within it are the same with chart position or not.
    buffer: graded ? mercatorBuffer(bounds, bufferMetres) * REACH_SLACK : maxReach,
    reachBase,
    maxReach,
    perMetre,
    graded,
    clearAbove,
    risk: opts.risk,
    maxRisk: 0,
    stopWhenCertain: opts.stopWhenCertain === true,
    result: { ...EMPTY },
    rect: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    coveredDMin: Infinity,
    cells: new Set(),
    visits: 0,
    shadow: graded
      ? shadowFor(store, geom, expandRect(bounds, maxReach), maxReach, toGround)
      : undefined
  };
}

/**
 * Conservative minimum depth over `geom` widened by the ground buffer, and
 * with `chartPosition` the risk of the tiles beyond it weighted by the chart's
 * position uncertainty. Tiles never built (outside the chart) count as
 * NO_DATA. A footprint or buffer reaching past ±180° is also walked one world
 * over, so the tiles at the other end of the world count too.
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
    if (t.chart) {
      const lat = out.riskTile.center[1];
      const extent = tileSize(t.z) * Math.cos((lat * Math.PI) / 180) * Math.SQRT2;
      out.riskTile.chart = { ...t.chart, extent };
    }
  }
  if (w.worst) {
    const r = tileRect(w.worst.z, w.worst.x, w.worst.y);
    out.worst = { ...w.worst, center: fromMercator((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2) };
  }
  return out;
}
