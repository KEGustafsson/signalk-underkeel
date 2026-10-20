import type { Rect, XY } from "../../src/foundation/geo";
import {
  expandRect,
  fromMercator,
  shiftRect,
  tileKey,
  tileRange,
  tileRect,
  worldShifts
} from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import { geomBounds, geomRectDistance, shiftGeom } from "../../src/foundation/geometry";
import { probabilityBelowZero } from "../../src/foundation/stats";
import { chartReach, surveySigmaP } from "../../src/spatial/chart-position";
import type { SurveySigmaP } from "../../src/spatial/chart-position";
import type { NodeStore, NodeValues } from "../../src/spatial/node-store";
import { combine, EMPTY, FLAGS, NO_DATA } from "../../src/spatial/node-store";
import type { DepthResult, QueryOptions } from "../../src/spatial/pyramid";
import { mercatorBuffer, RISK_STOP_BELOW } from "../../src/spatial/pyramid";

/**
 * The tile walk of `minDepthOver` as it stood at ea8277a, before the
 * look-ahead speed-ups: Math.hypot distances, a fresh rectangle and value
 * object per tile, no early stop and no inside flag. Equality tests run it
 * beside the current walk on random stores and footprints.
 */

const rectGap = (a: Rect, b: Rect): number =>
  Math.hypot(
    Math.max(0, a.minX - b.maxX, b.minX - a.maxX),
    Math.max(0, a.minY - b.maxY, b.minY - a.maxY)
  );

const pointRectDistance = (p: XY, r: Rect): number =>
  Math.hypot(Math.max(r.minX - p[0], 0, p[0] - r.maxX), Math.max(r.minY - p[1], 0, p[1] - r.maxY));

interface Walk {
  store: NodeStore;
  geom: Geom;
  bounds: Rect;
  vertex?: XY;
  buffer: number;
  maxReach: number;
  perMetre: number;
  k: number;
  survey?: SurveySigmaP;
  clearAbove: number;
  result: NodeValues;
  coveredDMin: number;
  cells: Set<number>;
  worst?: { z: number; x: number; y: number };
  visits: number;
  risk?: { threshold: number; sigmaExtra: number };
  maxRisk: number;
  riskTile?: { v: NodeValues; z: number; x: number; y: number; risk: number };
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
    const risk = probabilityBelowZero(
      v.dMin - w.risk.threshold,
      Math.hypot(v.sigmaD, w.risk.sigmaExtra)
    );
    if (w.riskTile === undefined || risk > w.riskTile.risk) {
      w.riskTile = { v, z, x, y, risk };
      w.maxRisk = risk;
    }
  }
}

const PRECISE_FLAGS =
  FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

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

function reachOf(w: Walk, i: number): number {
  if (!w.survey || i < 0) {
    return w.buffer;
  }
  return w.buffer + w.perMetre * chartReach(w.k, w.store.surveySigma(i));
}

function visit(w: Walk, z: number, x: number, y: number): void {
  const rect = tileRect(z, x, y);
  const gap = rectGap(w.bounds, rect);
  if (gap > w.maxReach) {
    return;
  }
  const i = w.store.find(z, x, y);
  const reach = reachOf(w, i);
  if (gap > reach) {
    return;
  }
  const close = w.vertex !== undefined && pointRectDistance(w.vertex, rect) <= reach;
  if (!close && geomRectDistance(w.geom, rect, reach) > reach) {
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
  visit(w, z + 1, 2 * x, 2 * y);
  visit(w, z + 1, 2 * x + 1, 2 * y);
  visit(w, z + 1, 2 * x, 2 * y + 1);
  visit(w, z + 1, 2 * x + 1, 2 * y + 1);
}

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

function walkFor(store: NodeStore, geom: Geom, opts: QueryOptions): Walk {
  const bounds = geomBounds(geom);
  const bufferMetres = opts.bufferMetres ?? 0;
  const k = opts.chartReachK ?? 0;
  const survey = k > 0 ? surveySigmaP(store) : undefined;
  const ground = bufferMetres + (survey ? chartReach(k, survey.max) : 0);
  const maxReach = mercatorBuffer(bounds, ground);
  const perMetre = ground > 0 ? maxReach / ground : 0;
  const clearAbove = Math.max(
    opts.clearAbove ?? (opts.risk ? -Infinity : Infinity),
    opts.risk?.threshold ?? -Infinity
  );
  return {
    store,
    geom,
    bounds,
    buffer: survey ? perMetre * bufferMetres : maxReach,
    maxReach,
    perMetre,
    k,
    survey,
    clearAbove,
    risk: opts.risk,
    maxRisk: 0,
    result: EMPTY,
    coveredDMin: Infinity,
    cells: new Set(),
    visits: 0
  };
}

const centre = (z: number, x: number, y: number) => {
  const r = tileRect(z, x, y);
  return fromMercator((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2);
};

export function referenceMinDepthOver(
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
    w.vertex = vertexOf(w.geom);
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
    maxRisk: w.maxRisk
  };
  if (w.riskTile) {
    const t = w.riskTile;
    out.riskTile = { ...t.v, risk: t.risk, center: centre(t.z, t.x, t.y) };
  }
  if (w.worst) {
    out.worst = { ...w.worst, center: centre(w.worst.z, w.worst.x, w.worst.y) };
  }
  return out;
}
