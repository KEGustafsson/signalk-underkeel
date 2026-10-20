import type { Rect, XY } from "./geo";
import { emptyRect, extendRect } from "./geo";

/**
 * Planar geometry in Web Mercator metres. Rings are implicitly closed; a
 * repeated closing vertex is harmless.
 */

export type Ring = readonly XY[];

export interface PolygonGeom {
  outer: Ring;
  holes: readonly Ring[];
}

export type Geom =
  | { type: "point"; p: XY }
  | { type: "line"; coords: readonly XY[] }
  | { type: "polygon"; polygons: readonly PolygonGeom[] };

/** Bounding box; for polygons the outer rings suffice, holes lie inside them. */
export function geomBounds(geom: Geom): Rect {
  const rect = emptyRect();
  if (geom.type === "point") {
    extendRect(rect, geom.p[0], geom.p[1]);
  } else if (geom.type === "line") {
    for (const p of geom.coords) {
      extendRect(rect, p[0], p[1]);
    }
  } else {
    for (const poly of geom.polygons) {
      for (const p of poly.outer) {
        extendRect(rect, p[0], p[1]);
      }
    }
  }
  return rect;
}

/** A copy of `geom` moved `dx` Mercator metres east. */
export function shiftGeom(geom: Geom, dx: number): Geom {
  const move = (p: XY): XY => [p[0] + dx, p[1]];
  if (geom.type === "point") {
    return { type: "point", p: move(geom.p) };
  }
  if (geom.type === "line") {
    return { type: "line", coords: geom.coords.map(move) };
  }
  return {
    type: "polygon",
    polygons: geom.polygons.map((poly) => ({
      outer: poly.outer.map(move),
      holes: poly.holes.map((h) => h.map(move))
    }))
  };
}

/** Even-odd ray cast; a point exactly on an edge may fall either side. */
export function pointInRing(p: XY, ring: Ring): boolean {
  return inRing(p[0], p[1], ring);
}

// The query hot path calls these per tile; scalar arguments keep it allocation-free.
// Math.hypot was 27 % of a look-ahead tick's allocation. Mercator metres (< 4e7)
// cannot overflow a square, and the query walk widens its reach by REACH_SLACK
// so a result 1 ulp above Math.hypot's still counts.

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i] as XY;
    const b = ring[j] as XY;
    if (a[1] > y !== b[1] > y) {
      const xCross = ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0];
      if (x < xCross) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function inPolygon(x: number, y: number, poly: PolygonGeom): boolean {
  if (!inRing(x, y, poly.outer)) {
    return false;
  }
  for (const hole of poly.holes) {
    if (inRing(x, y, hole)) {
      return false;
    }
  }
  return true;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(p: XY, poly: PolygonGeom): boolean {
  return inPolygon(p[0], p[1], poly);
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

/** Distance from p to the closest point of segment a→b (a point segment when a = b). */
export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  return segmentDistance(p[0], p[1], a, b);
}

/** 0 inside or on the rectangle, else the distance to its nearest edge or corner. */
export function pointRectDistance(p: XY, r: Rect): number {
  const dx = Math.max(r.minX - p[0], 0, p[0] - r.maxX);
  const dy = Math.max(r.minY - p[1], 0, p[1] - r.maxY);
  return Math.sqrt(dx * dx + dy * dy);
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

const span = { t0: 0, t1: 1 };

/** Liang–Barsky: does segment a→b touch the closed rectangle? */
export function segmentIntersectsRect(a: XY, b: XY, r: Rect): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  span.t0 = 0;
  span.t1 = 1;
  return (
    clip(-dx, a[0] - r.minX, span) &&
    clip(dx, r.maxX - a[0], span) &&
    clip(-dy, a[1] - r.minY, span) &&
    clip(dy, r.maxY - a[1], span)
  );
}

function rectCorners(r: Rect): XY[] {
  return [
    [r.minX, r.minY],
    [r.maxX, r.minY],
    [r.maxX, r.maxY],
    [r.minX, r.maxY]
  ];
}

/** Shortest distance between segment a→b and a rectangle (0 when they touch). */
export function segmentRectDistance(a: XY, b: XY, r: Rect): number {
  if (segmentIntersectsRect(a, b, r)) {
    return 0;
  }
  return Math.min(
    pointRectDistance(a, r),
    pointRectDistance(b, r),
    segmentDistance(r.minX, r.minY, a, b),
    segmentDistance(r.maxX, r.minY, a, b),
    segmentDistance(r.maxX, r.maxY, a, b),
    segmentDistance(r.minX, r.maxY, a, b)
  );
}

/** Segment distance, or Infinity when its bounding box alone is farther than `limit`. */
function segmentRectDistanceUpTo(a: XY, b: XY, r: Rect, limit: number): number {
  if (
    Math.min(a[0], b[0]) > r.maxX + limit ||
    Math.max(a[0], b[0]) < r.minX - limit ||
    Math.min(a[1], b[1]) > r.maxY + limit ||
    Math.max(a[1], b[1]) < r.minY - limit
  ) {
    return Infinity;
  }
  return segmentRectDistance(a, b, r);
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

/**
 * Distance from a rectangle to the area of a polygon (0 when they overlap).
 * If no rectangle corner lies in the area, any overlap must cross the area's
 * boundary, so the boundary distance is exact.
 */
export function polygonRectDistance(poly: PolygonGeom, r: Rect, limit = Infinity): number {
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

/**
 * Shortest distance from a rectangle to a geometry, in Mercator metres.
 * Distances greater than `limit` may be reported as Infinity, which lets
 * callers that only compare against a threshold skip far segments.
 */
export function geomRectDistance(geom: Geom, r: Rect, limit = Infinity): number {
  if (geom.type === "point") {
    return pointRectDistance(geom.p, r);
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

/**
 * True only when the rectangle lies wholly inside one polygon of the area.
 * A rectangle spanning two touching polygons returns false; callers treat
 * false as "subdivide", so a false negative costs work, never safety.
 */
export function geomContainsRect(geom: Geom, r: Rect): boolean {
  if (geom.type !== "polygon") {
    return false;
  }
  const corners = rectCorners(r);
  return geom.polygons.some(
    (poly) =>
      corners.every((c) => pointInPolygon(c, poly)) && polygonBoundaryRectDistance(poly, r, 0) > 0
  );
}

/** All four corners of `r` lie within `d` of segment a→b. */
function cornersNearSegment(r: Rect, a: XY, b: XY, d: number): boolean {
  return (
    segmentDistance(r.minX, r.minY, a, b) <= d &&
    segmentDistance(r.maxX, r.minY, a, b) <= d &&
    segmentDistance(r.maxX, r.maxY, a, b) <= d &&
    segmentDistance(r.minX, r.maxY, a, b) <= d
  );
}

function pathHoldsRect(coords: readonly XY[], closed: boolean, r: Rect, d: number): boolean {
  const n = coords.length;
  for (let i = closed ? 0 : 1; i < n; i++) {
    if (cornersNearSegment(r, coords[i === 0 ? n - 1 : i - 1] as XY, coords[i] as XY, d)) {
      return true;
    }
  }
  return false;
}

/**
 * True only when every point of the rectangle lies within `d` of the
 * geometry: inside one of its polygons, or with all four corners within `d`
 * of one vertex or one edge. A disc or a capsule is convex, so it then
 * holds the whole rectangle. False costs a caller work, never safety.
 */
export function rectWithin(geom: Geom, r: Rect, d: number): boolean {
  if (geom.type === "point") {
    return cornersNearSegment(r, geom.p, geom.p, d);
  }
  if (geom.type === "line") {
    return d > 0 && pathHoldsRect(geom.coords, false, r, d);
  }
  for (const poly of geom.polygons) {
    const inside =
      inPolygon(r.minX, r.minY, poly) &&
      inPolygon(r.maxX, r.minY, poly) &&
      inPolygon(r.maxX, r.maxY, poly) &&
      inPolygon(r.minX, r.maxY, poly) &&
      polygonBoundaryRectDistance(poly, r, 0) > 0;
    if (inside || (d > 0 && pathHoldsRect(poly.outer, true, r, d))) {
      return true;
    }
  }
  return false;
}

/** Below this length (metres) an edge is not matched against its neighbours. */
const MIN_SHARED_EDGE = 1e-3;
/** Offset (metres) of the side probes from an edge's midpoint. */
const SIDE_PROBE = 1e-5;
const LEFT = 1;
const RIGHT = 2;

/** Which sides of edge a→b, a before b, lie inside the polygon: LEFT | RIGHT bits. */
function interiorSides(a: XY, b: XY, len: number, poly: PolygonGeom): number {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = (-(b[1] - a[1]) / len) * SIDE_PROBE;
  const ny = ((b[0] - a[0]) / len) * SIDE_PROBE;
  return (
    (inPolygon(mx + nx, my + ny, poly) ? LEFT : 0) | (inPolygon(mx - nx, my - ny, poly) ? RIGHT : 0)
  );
}

/**
 * Adds the sides of every ring edge that touches `r` to `sides`, keyed by
 * the edge with its endpoints in lexicographic order. False when an edge
 * is too short to probe.
 */
function collectEdges(poly: PolygonGeom, r: Rect, sides: Map<string, number>): boolean {
  for (const ring of [poly.outer, ...poly.holes]) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const p = ring[j] as XY;
      const q = ring[i] as XY;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len === 0 || !segmentIntersectsRect(p, q, r)) {
        continue;
      }
      if (len < MIN_SHARED_EDGE) {
        return false;
      }
      const [a, b] = p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? [p, q] : [q, p];
      const key = `${a[0]},${a[1]},${b[0]},${b[1]}`;
      sides.set(key, (sides.get(key) ?? 0) | interiorSides(a, b, len, poly));
    }
  }
  return true;
}

/**
 * True only when the areas together cover the closed rectangle. Every edge
 * that touches it must have area on both sides, which holds where two
 * polygons share the edge vertex for vertex; with no boundary of the union
 * crossing the rectangle, its centre decides. An edge split differently on
 * each side, or two areas that overlap rather than meet, returns false:
 * callers read false as "not covered", so it costs precision, never safety.
 */
export function areasCoverRect(geoms: readonly Geom[], r: Rect): boolean {
  const sides = new Map<string, number>();
  const polys = geoms.flatMap((g) => (g.type === "polygon" ? g.polygons : []));
  for (const poly of polys) {
    if (!collectEdges(poly, r, sides)) {
      return false;
    }
  }
  for (const s of sides.values()) {
    if (s !== (LEFT | RIGHT)) {
      return false;
    }
  }
  const cx = (r.minX + r.maxX) / 2;
  const cy = (r.minY + r.maxY) / 2;
  return polys.some((poly) => inPolygon(cx, cy, poly));
}
