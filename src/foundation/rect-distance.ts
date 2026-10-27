import type { Rect, XY } from "./geo";
import type { PolygonGeom } from "./geometry";

/**
 * Distances from a rectangle to segments, and to a path's or polygon's edges
 * laid out once in a flat array (`geometry.ts` geomRectDistance). The query
 * hot path calls these per tile; scalar arguments keep it allocation-free.
 */

/** Squared distance from (x, y) to the segment from (ax, ay) by (dx, dy), len2 = dx² + dy². */
export function segmentDistance2(
  x: number,
  y: number,
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  len2: number
): number {
  const t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
  const c = Math.max(0, Math.min(1, t));
  const ex = x - (ax + c * dx);
  const ey = y - (ay + c * dy);
  return ex * ex + ey * ey;
}

/** Squared distance from (x, y) to the rectangle, 0 inside or on it. */
export function pointRectDistance2(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dy = Math.max(r.minY - y, 0, y - r.maxY);
  return dx * dx + dy * dy;
}

/** One Liang–Barsky clip against edge (p, q); returns false when the segment misses. */
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

/** The part of the segment last tested by `segmentTouchesRect` that lies in the rectangle. */
export const span = { t0: 0, t1: 1 };

/** Liang–Barsky: does segment (ax, ay)→(bx, by) touch the closed rectangle? */
export function segmentTouchesRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: Rect
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  span.t0 = 0;
  span.t1 = 1;
  return (
    clip(-dx, ax - r.minX, span) &&
    clip(dx, r.maxX - ax, span) &&
    clip(-dy, ay - r.minY, span) &&
    clip(dy, r.maxY - ay, span)
  );
}

/**
 * Distance from a segment that misses the rectangle to it: the least of its
 * ends' and the corners' distances, taken squared. A correctly rounded square
 * root never decreases, so the root of the least is the least root.
 */
export function apartDistance(ax: number, ay: number, bx: number, by: number, r: Rect): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  return Math.sqrt(
    Math.min(
      pointRectDistance2(ax, ay, r),
      pointRectDistance2(bx, by, r),
      segmentDistance2(r.minX, r.minY, ax, ay, dx, dy, len2),
      segmentDistance2(r.maxX, r.minY, ax, ay, dx, dy, len2),
      segmentDistance2(r.maxX, r.maxY, ax, ay, dx, dy, len2),
      segmentDistance2(r.minX, r.maxY, ax, ay, dx, dy, len2)
    )
  );
}

/**
 * Relative bound, with a wide margin, on how far a distance or a ray crossing
 * computed here can round from the exact one: about 1e-15 of the coordinates'
 * magnitude.
 */
export const ROUNDING = 1e-9;

/**
 * Values per laid-out edge a→b: ax, ay, bx, by, its box loX, hiX, loY, hiY,
 * and |loX| + |hiX| + |loY| + |hiY|.
 */
const EDGE = 9;

/** Lays out the edges of a path, closed or not, from edge `at`; returns the edge after the last. */
function layEdges(coords: readonly XY[], closed: boolean, e: Float64Array, at: number): number {
  const n = coords.length;
  let o = at * EDGE;
  for (let i = closed ? 0 : 1; i < n; i++, o += EDGE) {
    const a = coords[i === 0 ? n - 1 : i - 1] as XY;
    const b = coords[i] as XY;
    const loX = Math.min(a[0], b[0]);
    const hiX = Math.max(a[0], b[0]);
    const loY = Math.min(a[1], b[1]);
    const hiY = Math.max(a[1], b[1]);
    e[o] = a[0];
    e[o + 1] = a[1];
    e[o + 2] = b[0];
    e[o + 3] = b[1];
    e[o + 4] = loX;
    e[o + 5] = hiX;
    e[o + 6] = loY;
    e[o + 7] = hiY;
    e[o + 8] = Math.abs(loX) + Math.abs(hiX) + Math.abs(loY) + Math.abs(hiY);
  }
  return o / EDGE;
}

const edgeCount = (coords: readonly XY[], closed: boolean): number =>
  closed ? coords.length : Math.max(0, coords.length - 1);

/**
 * The least segment distance to `r` over edges [from, to), folded in order;
 * an edge whose box lies, along one axis, farther than the least of `limit`
 * and the distance so far counts as Infinity. An edge whose box lies farther
 * than the distance so far by more than ROUNDING is skipped: its distance
 * computed in full would be farther too and leave the fold as it is.
 */
function edgesRectDistance(
  e: Float64Array,
  from: number,
  to: number,
  r: Rect,
  limit: number
): number {
  let d = Infinity;
  const rectScale = Math.abs(r.minX) + Math.abs(r.maxX) + Math.abs(r.minY) + Math.abs(r.maxY);
  for (let o = from * EDGE; o < to * EDGE && d > 0; o += EDGE) {
    const upTo = Math.min(limit, d);
    const loX = e[o + 4] as number;
    const hiX = e[o + 5] as number;
    const loY = e[o + 6] as number;
    const hiY = e[o + 7] as number;
    if (loX > r.maxX + upTo || hiX < r.minX - upTo || loY > r.maxY + upTo || hiY < r.minY - upTo) {
      continue;
    }
    const gx = Math.max(0, loX - r.maxX, r.minX - hiX);
    const gy = Math.max(0, loY - r.maxY, r.minY - hiY);
    const slack = ROUNDING * (rectScale + (e[o + 8] as number));
    const past = d + slack;
    if (gx * gx + gy * gy > past * past) {
      continue;
    }
    const ax = e[o] as number;
    const ay = e[o + 1] as number;
    const bx = e[o + 2] as number;
    const by = e[o + 3] as number;
    // Boxes farther apart along an axis put every Liang–Barsky ratio past [0, 1].
    const touches = gx <= slack && gy <= slack && segmentTouchesRect(ax, ay, bx, by, r);
    d = Math.min(d, touches ? 0 : apartDistance(ax, ay, bx, by, r));
  }
  return d;
}

/** A polygon's outer-ring box and its edges, laid out once for many rectangles. */
export interface MeasuredPolygon {
  poly: PolygonGeom;
  minY: number;
  maxY: number;
  /** The outer ring's box sides, widened by ROUNDING of their magnitude. */
  xLo: number;
  xHi: number;
  /** The outer ring's edges, then each hole's. */
  edges: Float64Array;
  /** The edge after each ring's last, outer ring first. */
  ends: number[];
}

/** Lays out `poly` into `into`, growing its edge array when short. */
export function measurePolygon(poly: PolygonGeom, into: MeasuredPolygon): MeasuredPolygon {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly.outer) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const m = ROUNDING * (Math.abs(minX) + Math.abs(maxX));
  let count = edgeCount(poly.outer, true);
  for (const hole of poly.holes) {
    count += edgeCount(hole, true);
  }
  if (into.edges.length < count * EDGE) {
    into.edges = new Float64Array(count * EDGE);
  }
  into.ends.length = 0;
  let at = layEdges(poly.outer, true, into.edges, 0);
  into.ends.push(at);
  for (const hole of poly.holes) {
    at = layEdges(hole, true, into.edges, at);
    into.ends.push(at);
  }
  into.poly = poly;
  into.minY = minY;
  into.maxY = maxY;
  into.xLo = minX - m;
  into.xHi = maxX + m;
  return into;
}

export const emptyPolygon = (): MeasuredPolygon => ({
  poly: { outer: [], holes: [] },
  minY: 0,
  maxY: 0,
  xLo: 0,
  xHi: 0,
  edges: new Float64Array(0),
  ends: []
});

/** The polygon's boundary distance, holes included, folded ring by ring. */
export function boundaryDistance(m: MeasuredPolygon, r: Rect, limit: number): number {
  let d = edgesRectDistance(m.edges, 0, m.ends[0] as number, r, limit);
  for (let h = 1; h < m.ends.length; h++) {
    if (d === 0) {
      break;
    }
    const from = m.ends[h - 1] as number;
    d = Math.min(d, edgesRectDistance(m.edges, from, m.ends[h] as number, r, Math.min(limit, d)));
  }
  return d;
}

/** A line's edges laid out once for many rectangles. */
export function measureLine(coords: readonly XY[]): Float64Array {
  const edges = new Float64Array(edgeCount(coords, false) * EDGE);
  layEdges(coords, false, edges, 0);
  return edges;
}

/** The distance from `r` to a line laid out by `measureLine`. */
export function lineDistance(edges: Float64Array, r: Rect, limit: number): number {
  return edgesRectDistance(edges, 0, edges.length / EDGE, r, limit);
}

/** A shared layout of up to this many edges is kept for the next call. */
const SCRATCH_EDGES = 4096;

let scratch = emptyPolygon();

/** `poly` laid out in a shared scratch, for one call. */
export function scratchPolygon(poly: PolygonGeom): MeasuredPolygon {
  if (scratch.edges.length > SCRATCH_EDGES * EDGE) {
    scratch = emptyPolygon();
  }
  return measurePolygon(poly, scratch);
}

/** The distance from `r` to a line, laid out in the shared scratch for this call. */
export function scratchLineDistance(coords: readonly XY[], r: Rect, limit: number): number {
  const count = edgeCount(coords, false);
  if (scratch.edges.length < count * EDGE || scratch.edges.length > SCRATCH_EDGES * EDGE) {
    scratch = emptyPolygon();
    scratch.edges = new Float64Array(count * EDGE);
  }
  layEdges(coords, false, scratch.edges, 0);
  return edgesRectDistance(scratch.edges, 0, count, r, limit);
}
