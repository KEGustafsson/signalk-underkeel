import type { Rect, XY } from "../../src/foundation/geo";
import {
  expandRect,
  fromMercator,
  rectContainsRect,
  rectGap,
  shiftRect,
  tileKey,
  tileRange,
  tileRect,
  tileRectInto,
  tileSize,
  worldShifts
} from "../../src/foundation/geo";
import type { Geom, PolygonGeom } from "../../src/foundation/geometry";
import {
  geomBounds,
  measureGeom,
  pointInPolygon,
  rectWithin,
  shiftGeom
} from "../../src/foundation/geometry";
import { normalCdf } from "../../src/foundation/stats";
import {
  chartReach,
  chartSigma,
  chartWeight,
  FLAG_SIGMAS,
  flagReach,
  MAX_CHART_SIGMA
} from "../../src/spatial/chart-position";
import type { NodeStore, NodeValues } from "../../src/spatial/node-store";
import { EMPTY, FLAGS, NO_DATA } from "../../src/spatial/node-store";
import type { ChartReach, DepthResult, QueryOptions } from "../../src/spatial/pyramid";
import { mercatorBuffer, REACH_SLACK, RISK_STOP_BELOW } from "../../src/spatial/pyramid";
import type { Walk } from "../../src/spatial/walk";
import { certain, foldFlags, REACH_FLAGS, riskAt, take, takeStandIn } from "../../src/spatial/walk";

/**
 * `minDepthOver` with chart position and the survey shadow as it stood at
 * 118913f, before the look-ahead tick's chart walk was sped up: rectangle
 * distances over arrays of vertices, a shadow answer and a P explanation
 * built for every tile. Equality tests run it beside the current walk; the
 * fold helpers of walk.ts are shared, unchanged since.
 */

// ---- foundation/geometry.ts distances at 118913f ----

function inPolygon(x: number, y: number, poly: PolygonGeom): boolean {
  return pointInPolygon([x, y], poly);
}

function segmentDistance(x: number, y: number, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
  const c = Math.max(0, Math.min(1, t));
  const ex = x - (a[0] + c * dx);
  const ey = y - (a[1] + c * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

export function referencePointRectDistance(p: XY, r: Rect): number {
  const dx = Math.max(r.minX - p[0], 0, p[0] - r.maxX);
  const dy = Math.max(r.minY - p[1], 0, p[1] - r.maxY);
  return Math.sqrt(dx * dx + dy * dy);
}

function clip(p: number, q: number, t: { t0: number; t1: number }): boolean {
  if (p === 0) {
    return q >= 0;
  }
  const r = q / p;
  if (p < 0) {
    t.t0 = Math.max(t.t0, r);
  } else {
    t.t1 = Math.min(t.t1, r);
  }
  return t.t0 <= t.t1;
}

function segmentIntersectsRect(a: XY, b: XY, r: Rect): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const span = { t0: 0, t1: 1 };
  return (
    clip(-dx, a[0] - r.minX, span) &&
    clip(dx, r.maxX - a[0], span) &&
    clip(-dy, a[1] - r.minY, span) &&
    clip(dy, r.maxY - a[1], span)
  );
}

export function referenceSegmentRectDistance(a: XY, b: XY, r: Rect): number {
  if (segmentIntersectsRect(a, b, r)) {
    return 0;
  }
  return Math.min(
    referencePointRectDistance(a, r),
    referencePointRectDistance(b, r),
    segmentDistance(r.minX, r.minY, a, b),
    segmentDistance(r.maxX, r.minY, a, b),
    segmentDistance(r.maxX, r.maxY, a, b),
    segmentDistance(r.minX, r.maxY, a, b)
  );
}

function segmentRectDistanceUpTo(a: XY, b: XY, r: Rect, limit: number): number {
  if (
    Math.min(a[0], b[0]) > r.maxX + limit ||
    Math.max(a[0], b[0]) < r.minX - limit ||
    Math.min(a[1], b[1]) > r.maxY + limit ||
    Math.max(a[1], b[1]) < r.minY - limit
  ) {
    return Infinity;
  }
  return referenceSegmentRectDistance(a, b, r);
}

function pathRectDistance(coords: readonly XY[], closed: boolean, r: Rect, limit: number): number {
  let d = Infinity;
  const n = coords.length;
  for (let i = closed ? 0 : 1; i < n && d > 0; i++) {
    const a = coords[i === 0 ? n - 1 : i - 1] as XY;
    d = Math.min(d, segmentRectDistanceUpTo(a, coords[i] as XY, r, Math.min(limit, d)));
  }
  return d;
}

function polygonBoundaryRectDistance(poly: PolygonGeom, r: Rect, limit: number): number {
  let d = pathRectDistance(poly.outer, true, r, limit);
  for (const hole of poly.holes) {
    if (d === 0) {
      break;
    }
    d = Math.min(d, pathRectDistance(hole, true, r, Math.min(limit, d)));
  }
  return d;
}

function polygonRectDistance(poly: PolygonGeom, r: Rect, limit: number): number {
  if (
    inPolygon(r.minX, r.minY, poly) ||
    inPolygon(r.maxX, r.minY, poly) ||
    inPolygon(r.maxX, r.maxY, poly) ||
    inPolygon(r.minX, r.maxY, poly)
  ) {
    return 0;
  }
  return polygonBoundaryRectDistance(poly, r, limit);
}

export function referenceGeomRectDistance(geom: Geom, r: Rect, limit = Infinity): number {
  if (geom.type === "point") {
    return referencePointRectDistance(geom.p, r);
  }
  if (geom.type === "line") {
    return pathRectDistance(geom.coords, false, r, limit);
  }
  let d = Infinity;
  for (const poly of geom.polygons) {
    d = Math.min(d, polygonRectDistance(poly, r, Math.min(limit, d)));
    if (d === 0) {
      break;
    }
  }
  return d;
}

// ---- spatial/survey-shadow.ts at 118913f ----

interface Shadow {
  ratio: number;
  distance: number;
  sigmaP: number;
}

interface Entry {
  d: number;
  z: number;
  x: number;
  y: number;
}

function levelOf(store: NodeStore, i: number, z: number, x: number, y: number): number {
  if (i < 0 || (store.isSplit(i) && store.standIn(i, z, x, y))) {
    return MAX_CHART_SIGMA;
  }
  const sigma = store.surveySigma(i);
  if (sigma <= 0 || (store.values(i).flags & REACH_FLAGS) !== 0) {
    return MAX_CHART_SIGMA;
  }
  return Math.min(sigma, MAX_CHART_SIGMA);
}

class SurveyShadow {
  private readonly heap: Entry[] = [];
  private readonly steps: { at: number; sigma: number }[] = [];
  private level = 0;
  private searched = 0;

  constructor(
    private readonly store: NodeStore,
    private readonly geoms: readonly Geom[],
    reaches: readonly Rect[],
    private readonly ground: (mercator: number) => number,
    private readonly limit: number
  ) {
    for (const reach of reaches) {
      const range = tileRange(store.minZoom, reach);
      for (let x = range.minX; x <= range.maxX; x++) {
        for (let y = range.minY; y <= range.maxY; y++) {
          this.offer(store.minZoom, x, y);
        }
      }
    }
  }

  private offer(z: number, x: number, y: number): void {
    const rect = tileRect(z, x, y);
    let d = Infinity;
    for (const g of this.geoms) {
      d = Math.min(d, referenceGeomRectDistance(g, rect, this.limit));
    }
    if (d <= this.limit) {
      this.push({ d: this.ground(d), z, x, y });
    }
  }

  private extend(g: number): void {
    while (this.heap.length > 0 && this.level < MAX_CHART_SIGMA) {
      const top = this.heap[0] as Entry;
      if (top.d >= g) {
        this.searched = Math.max(this.searched, g);
        return;
      }
      this.pop();
      const { d, z, x, y } = top;
      const i = this.store.find(z, x, y);
      const level = levelOf(this.store, i, z, x, y);
      if (level <= this.level) {
        continue;
      }
      if (i >= 0 && this.store.isSplit(i) && !this.store.standIn(i, z, x, y)) {
        this.offer(z + 1, 2 * x, 2 * y);
        this.offer(z + 1, 2 * x + 1, 2 * y);
        this.offer(z + 1, 2 * x, 2 * y + 1);
        this.offer(z + 1, 2 * x + 1, 2 * y + 1);
        continue;
      }
      this.steps.push({ at: d, sigma: level });
      this.level = level;
    }
    this.searched = Infinity;
  }

  at(g: number): Shadow {
    if (!(g > 0)) {
      return { ratio: 0, distance: 0, sigmaP: 0 };
    }
    if (this.searched < g) {
      this.extend(g);
    }
    let best: Shadow = { ratio: 0, distance: 0, sigmaP: 0 };
    let sigma = MAX_CHART_SIGMA;
    for (let k = 0; k < this.steps.length; k++) {
      const step = this.steps[k] as { at: number; sigma: number };
      if (step.at >= g) {
        break;
      }
      sigma = step.sigma;
      const next = this.steps[k + 1];
      const end = next !== undefined && next.at < g ? next.at : g;
      if (end / sigma > best.ratio) {
        best = { ratio: end / sigma, distance: end, sigmaP: sigma };
      }
    }
    if (this.steps.length === 0 || (this.steps[0] as { at: number }).at >= g) {
      const ratio = g / sigma;
      return ratio > best.ratio ? { ratio, distance: g, sigmaP: sigma } : best;
    }
    return best;
  }

  private push(e: Entry): void {
    const a = this.heap;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as Entry).d <= e.d) {
        break;
      }
      a[i] = a[p] as Entry;
      i = p;
    }
    a[i] = e;
  }

  private pop(): void {
    const a = this.heap;
    const last = a.pop() as Entry;
    if (a.length === 0) {
      return;
    }
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      let md = last.d;
      if (l < a.length && (a[l] as Entry).d < md) {
        m = l;
        md = (a[l] as Entry).d;
      }
      if (r < a.length && (a[r] as Entry).d < md) {
        m = r;
      }
      if (m === i) {
        break;
      }
      a[i] = a[m] as Entry;
      i = m;
    }
    a[i] = last;
  }
}

type ShadowOf = () => SurveyShadow;

function shadowFor(
  store: NodeStore,
  geom: Geom,
  reach: Rect,
  limit: number,
  ground: (mercator: number) => number
): ShadowOf {
  let shadow: SurveyShadow | undefined;
  return () =>
    (shadow ??= new SurveyShadow(
      store,
      worldShifts(reach).map((s) => (s === 0 ? geom : shiftGeom(geom, s))),
      worldShifts(reach).map((s) => shiftRect(reach, s)),
      ground,
      limit
    ));
}

function shadedWeight(
  shadow: ShadowOf | undefined,
  ground: number,
  sigma: number,
  p: number,
  floor: number
): { risk: number; weight: number; shadow?: { distance: number; sigmaP: number } } {
  const weight = chartWeight(ground, sigma);
  const risk = p * weight;
  if (!shadow || ground <= 0 || risk <= floor) {
    return { risk, weight };
  }
  const s = shadow().at(ground);
  const cap = normalCdf(-s.ratio);
  if (cap >= weight) {
    return { risk, weight };
  }
  return { risk: p * cap, weight: cap, shadow: { distance: s.distance, sigmaP: s.sigmaP } };
}

function flagsShadowed(shadow: ShadowOf | undefined, ground: number): boolean {
  return shadow !== undefined && shadow().at(ground).ratio > FLAG_SIGMAS;
}

// ---- spatial/pyramid.ts at 118913f ----

/** The 118913f walk's state: walk.ts's, with its own shadow. */
interface RefWalk extends Omit<Walk, "shadow"> {
  refShadow?: ShadowOf;
}

const PRECISE_FLAGS = REACH_FLAGS;

/** walk.ts's fold helpers read no shadow, so the reference walk passes as theirs. */
const asWalk = (w: RefWalk): Walk => w as Walk;

function canStop(w: RefWalk, v: NodeValues): boolean {
  if (v.dMin < w.clearAbove || (v.flags & PRECISE_FLAGS) !== 0) {
    return false;
  }
  if (!w.risk) {
    return true;
  }
  return riskAt(asWalk(w), v.dMin, v.sigmaD) < RISK_STOP_BELOW;
}

function reachOf(w: RefWalk, i: number): number {
  if (!w.graded || i < 0) {
    return w.buffer;
  }
  const survey = w.store.surveySigma(i);
  const ground = Math.max(chartReach(Math.max(survey, w.store.topoSigma(i))), flagReach(survey));
  return w.reachBase + w.perMetre * ground;
}

function distanceTo(w: RefWalk, rect: Rect, reach: number): number {
  if (rectGap(w.bounds, rect) > reach) {
    return Infinity;
  }
  if (w.vertex !== undefined) {
    const d = referencePointRectDistance(w.vertex, rect);
    if (d <= w.buffer) {
      return d;
    }
  }
  return referenceGeomRectDistance(w.geom, rect, reach);
}

function bathyRisk(w: RefWalk, bathy: number, sigmaD: number, bound: boolean): number {
  const r = w.risk as { threshold: number; sigmaExtra: number };
  if (bound && bathy < r.threshold) {
    return 1;
  }
  return riskAt(asWalk(w), bathy, sigmaD);
}

function flagsReach(w: RefWalk, i: number, ground: number): boolean {
  return ground <= flagReach(w.store.surveySigma(i)) && !flagsShadowed(w.refShadow, ground);
}

function reachRisk(
  w: RefWalk,
  i: number,
  v: NodeValues,
  ground: number,
  bound: boolean
): { risk: number; chart: Omit<ChartReach, "extent">; dMin: number } | undefined {
  const survey = w.store.surveySigma(i);
  const topo = w.store.topoSigma(i);
  const bathy = Math.max(w.store.bathyDMinOf(i), v.dMin);
  let best: { risk: number; chart: Omit<ChartReach, "extent">; dMin: number } | undefined;
  const floor = Math.max(w.maxRisk, RISK_STOP_BELOW);
  if (survey > 0 && bathy !== Infinity) {
    const p = bathyRisk(w, bathy, v.sigmaD, bound);
    const { risk, weight, shadow } = shadedWeight(w.refShadow, ground, survey, p, floor);
    best = {
      risk,
      dMin: bathy,
      chart: {
        distance: ground,
        sigmaP: Math.min(MAX_CHART_SIGMA, survey),
        weight,
        source: "survey",
        ...(shadow && { shadow })
      }
    };
  }
  const drawn = Math.max(w.store.topoDMinOf(i), v.dMin);
  if (topo > 0 && drawn !== Infinity) {
    const p = bathyRisk(w, drawn, v.sigmaD, bound);
    const { risk, weight, shadow } = shadedWeight(w.refShadow, ground, topo, p, floor);
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

function takeBeyond(
  w: RefWalk,
  i: number,
  v: NodeValues,
  flags: number,
  ground: number,
  bound: boolean,
  tile: { z: number; x: number; y: number }
): void {
  if (flagsReach(w, i, ground)) {
    foldFlags(asWalk(w), v, flags);
  }
  if (!w.risk) {
    return;
  }
  const r = reachRisk(w, i, v, ground, bound);
  if (r && (w.riskTile === undefined || r.risk > w.riskTile.risk)) {
    const sigmaD = r.chart.source === "topography" && r.dMin === -Infinity ? 0 : v.sigmaD;
    w.riskTile = {
      v: { ...v, dMin: r.dMin, sigmaD, flags },
      ...tile,
      risk: r.risk,
      chart: r.chart
    };
    w.maxRisk = r.risk;
  }
}

function visitBeyond(w: RefWalk, i: number, ground: number, z: number, x: number, y: number): void {
  const v = w.store.values(i);
  if (!w.store.isSplit(i)) {
    takeBeyond(w, i, v, v.flags, ground, false, { z, x, y });
    return;
  }
  const inFlags = flagsReach(w, i, ground);
  const bound = w.risk ? (reachRisk(w, i, v, ground, true)?.risk ?? 0) : 0;
  const settled = bound <= Math.max(w.maxRisk, RISK_STOP_BELOW);
  if (settled && (!inFlags || (v.flags & PRECISE_FLAGS) === 0)) {
    if (inFlags) {
      foldFlags(asWalk(w), v, v.flags);
    }
    return;
  }
  const s = w.store.standIn(i, z, x, y);
  if (s) {
    takeBeyond(w, i, v, v.flags | FLAGS.NO_COVERAGE, ground, true, { z, x, y });
    return;
  }
  visit(w, z + 1, 2 * x, 2 * y, false);
  visit(w, z + 1, 2 * x + 1, 2 * y, false);
  visit(w, z + 1, 2 * x, 2 * y + 1, false);
  visit(w, z + 1, 2 * x + 1, 2 * y + 1, false);
}

function takeOutside(w: RefWalk, i: number, rect: Rect, z: number, x: number, y: number): boolean {
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

function negligible(w: RefWalk, i: number, gap: number): boolean {
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

function visit(w: RefWalk, z: number, x: number, y: number, inside: boolean): void {
  if (w.stopWhenCertain && certain(asWalk(w))) {
    return;
  }
  const rect = tileRectInto(z, x, y, w.rect);
  const i = w.store.find(z, x, y);
  if (!inside && !takeOutside(w, i, rect, z, x, y)) {
    return;
  }
  w.visits++;
  if (i < 0) {
    take(asWalk(w), NO_DATA, z, x, y);
    return;
  }
  const v = w.store.values(i);
  if (!w.store.isSplit(i) || canStop(w, v)) {
    take(asWalk(w), v, z, x, y);
    return;
  }
  const s = w.store.standIn(i, z, x, y);
  if (s) {
    takeStandIn(asWalk(w), v, s, z, x, y);
    return;
  }
  const within = inside || (rectContainsRect(w.hold, rect) && rectWithin(w.geom, rect, w.buffer));
  visit(w, z + 1, 2 * x, 2 * y, within);
  visit(w, z + 1, 2 * x + 1, 2 * y, within);
  visit(w, z + 1, 2 * x, 2 * y + 1, within);
  visit(w, z + 1, 2 * x + 1, 2 * y + 1, within);
}

function takeAdjustments(w: RefWalk, reach: Rect): void {
  const adj = w.store.adjustments;
  if (adj.size === 0) {
    return;
  }
  const z = w.store.adjustZoom;
  const range = tileRange(z, reach);
  const consider = (x: number, y: number, v: NodeValues): void => {
    if (referenceGeomRectDistance(w.geom, tileRect(z, x, y), w.buffer) <= w.buffer) {
      take(asWalk(w), v, z, x, y);
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

function walkFor(store: NodeStore, geom: Geom, opts: QueryOptions): RefWalk {
  const bounds = geomBounds(geom);
  const bufferMetres = opts.bufferMetres ?? 0;
  const graded = opts.chartPosition === true && chartSigma(store).max > 0;
  const ground = bufferMetres + (graded ? chartReach(chartSigma(store).max) : 0);
  const maxReach = mercatorBuffer(bounds, ground) * REACH_SLACK;
  const perMetre = ground > 0 ? maxReach / ground : 0;
  const clearAbove = Math.max(
    opts.clearAbove ?? (opts.risk ? -Infinity : Infinity),
    opts.risk?.threshold ?? -Infinity
  );
  const reachBase = graded ? perMetre * bufferMetres : maxReach;
  const toGround = (d: number): number => Math.max(0, (d - reachBase) / perMetre);
  return {
    store,
    geom,
    // Unread: the reference measures distances over the geometry's arrays.
    measured: measureGeom({ type: "point", p: [0, 0] }),
    bounds,
    hold: bounds,
    buffer: graded ? mercatorBuffer(bounds, bufferMetres) * REACH_SLACK : maxReach,
    reachBase,
    maxReach,
    perMetre,
    graded,
    clearAbove,
    risk: opts.risk,
    maxRisk: 0,
    stopWhenCertain: opts.stopWhenCertain === true,
    reachSource: "survey",
    result: { ...EMPTY },
    rect: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    coveredDMin: Infinity,
    cells: new Set(),
    visits: 0,
    refShadow: graded
      ? shadowFor(store, geom, expandRect(bounds, maxReach), maxReach, toGround)
      : undefined
  };
}

/** `minDepthOver` at 118913f. */
export function referenceGradedWalk(
  store: NodeStore,
  geom: Geom,
  opts: QueryOptions = {}
): DepthResult {
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
