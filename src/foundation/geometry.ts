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

/** Even-odd ray cast; a point exactly on an edge may fall either side. */
export function pointInRing(p: XY, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i] as XY;
    const b = ring[j] as XY;
    if (a[1] > p[1] !== b[1] > p[1]) {
      const xCross = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < xCross) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(p: XY, poly: PolygonGeom): boolean {
  if (!pointInRing(p, poly.outer)) {
    return false;
  }
  return !poly.holes.some((hole) => pointInRing(p, hole));
}

/** Distance from p to the closest point of segment a→b (a point segment when a = b). */
export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const c = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + c * dx), p[1] - (a[1] + c * dy));
}

/** 0 inside or on the rectangle, else the distance to its nearest edge or corner. */
export function pointRectDistance(p: XY, r: Rect): number {
  const dx = Math.max(r.minX - p[0], 0, p[0] - r.maxX);
  const dy = Math.max(r.minY - p[1], 0, p[1] - r.maxY);
  return Math.hypot(dx, dy);
}

/** Liang–Barsky: does segment a→b touch the closed rectangle? */
export function segmentIntersectsRect(a: XY, b: XY, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges: [number, number][] = [
    [-dx, a[0] - r.minX],
    [dx, r.maxX - a[0]],
    [-dy, a[1] - r.minY],
    [dy, r.maxY - a[1]]
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) {
        return false;
      }
      continue;
    }
    const t = q / p;
    if (p < 0) {
      t0 = Math.max(t0, t);
    } else {
      t1 = Math.min(t1, t);
    }
    if (t0 > t1) {
      return false;
    }
  }
  return true;
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
  let d = Math.min(pointRectDistance(a, r), pointRectDistance(b, r));
  for (const c of rectCorners(r)) {
    d = Math.min(d, pointSegmentDistance(c, a, b));
  }
  return d;
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
  if (rectCorners(r).some((c) => pointInPolygon(c, poly))) {
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
