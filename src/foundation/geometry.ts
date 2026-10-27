import type { Rect, XY } from "./geo";
import { emptyRect, extendRect } from "./geo";
import type { MeasuredPolygon } from "./rect-distance";
import {
  apartDistance,
  boundaryDistance,
  emptyPolygon,
  lineDistance,
  measureLine,
  measurePolygon,
  pointRectDistance2,
  scratchLineDistance,
  scratchPolygon,
  segmentDistance2,
  segmentTouchesRect,
  span
} from "./rect-distance";

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
  return Math.sqrt(segmentDistance2(x, y, a[0], a[1], dx, dy, dx * dx + dy * dy));
}

/** Distance from p to the closest point of segment a→b (a point segment when a = b). */
export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  return segmentDistance(p[0], p[1], a, b);
}

/** 0 inside or on the rectangle, else the distance to its nearest edge or corner. */
export function pointRectDistance(p: XY, r: Rect): number {
  return Math.sqrt(pointRectDistance2(p[0], p[1], r));
}

/** Liang–Barsky: does segment a→b touch the closed rectangle? */
export function segmentIntersectsRect(a: XY, b: XY, r: Rect): boolean {
  return segmentTouchesRect(a[0], a[1], b[0], b[1], r);
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
  return apartDistance(a[0], a[1], b[0], b[1], r);
}

function polygonBoundaryRectDistance(poly: PolygonGeom, r: Rect, limit: number): number {
  return boundaryDistance(scratchPolygon(poly), r, limit);
}

/**
 * `inPolygon` for a point, which off the outer ring's box is out without the
 * ray cast: at or above its top or below its bottom no edge straddles it,
 * and a crossing rounds past its sides by far less than the ROUNDING the box
 * is widened by, so beyond them every straddling edge crosses the ray or none
 * does.
 */
function inMeasured(x: number, y: number, m: MeasuredPolygon): boolean {
  return y >= m.minY && y < m.maxY && x >= m.xLo && x <= m.xHi && inPolygon(x, y, m.poly);
}

function cornerInPolygon(r: Rect, m: MeasuredPolygon): boolean {
  return (
    inMeasured(r.minX, r.minY, m) ||
    inMeasured(r.maxX, r.minY, m) ||
    inMeasured(r.maxX, r.maxY, m) ||
    inMeasured(r.minX, r.maxY, m)
  );
}

/**
 * If no rectangle corner lies in the area, any overlap must cross the area's
 * boundary, so the boundary distance is exact.
 */
function measuredPolygonDistance(m: MeasuredPolygon, r: Rect, limit: number): number {
  return cornerInPolygon(r, m) ? 0 : boundaryDistance(m, r, limit);
}

/** Distance from a rectangle to the area of a polygon (0 when they overlap). */
export function polygonRectDistance(poly: PolygonGeom, r: Rect, limit = Infinity): number {
  return measuredPolygonDistance(scratchPolygon(poly), r, limit);
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
    return scratchLineDistance(geom.coords, r, limit);
  }
  let d = Infinity;
  for (const poly of geom.polygons) {
    d = Math.min(d, measuredPolygonDistance(scratchPolygon(poly), r, Math.min(limit, d)));
    if (d === 0) {
      break;
    }
  }
  return d;
}

/** A geometry laid out once for the many `measuredRectDistance` calls of a query walk. */
export interface MeasuredGeom {
  geom: Geom;
  polygons: MeasuredPolygon[];
  /** A line's edges; empty for a point or polygons. */
  line: Float64Array;
}

/** Lays out `geom` for `measuredRectDistance`. */
export function measureGeom(geom: Geom): MeasuredGeom {
  return {
    geom,
    polygons:
      geom.type === "polygon" ? geom.polygons.map((p) => measurePolygon(p, emptyPolygon())) : [],
    line: geom.type === "line" ? measureLine(geom.coords) : new Float64Array(0)
  };
}

/** `geomRectDistance` of the geometry `m` was measured from. */
export function measuredRectDistance(m: MeasuredGeom, r: Rect, limit = Infinity): number {
  const geom = m.geom;
  if (geom.type === "point") {
    return pointRectDistance(geom.p, r);
  }
  if (geom.type === "line") {
    return lineDistance(m.line, r, limit);
  }
  let d = Infinity;
  for (const poly of m.polygons) {
    d = Math.min(d, measuredPolygonDistance(poly, r, Math.min(limit, d)));
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
 * Gaps between areas no wider than this, in Mercator metres (at most as
 * many metres on the ground), count as covered by `areasCoverRect`. Two
 * cells, or two quality zones, that meet along one line are often drawn
 * with their vertices split differently along it, or a few centimetres
 * apart: Rijkswaterstaat's Inland ENC cells 1R7WAD07 and 1R7WAD10 meet so,
 * and their CATZOC A1 and B zones leave a sliver under 10 cm. Read exactly,
 * every tile on such a seam had no coverage or no assessed survey.
 */
export const SEAM_TOLERANCE = 0.5;

/** Where segment a→b crosses segment c→d, as a fraction along a→b; undefined when it does not. */
function crossingAt(a: XY, b: XY, c: XY, d: XY): number | undefined {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) {
    return undefined;
  }
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : undefined;
}

/**
 * Whether the line SEAM_TOLERANCE off edge a→b on its `outward` side (+1
 * left, −1 right) lies in the areas wherever the edge is in `r`. Along that
 * line the areas only start or stop where it crosses one of their edges, so
 * the midpoint between each pair of crossings decides its stretch.
 */
function outsideCovered(
  a: XY,
  b: XY,
  len: number,
  outward: number,
  polys: readonly PolygonGeom[],
  r: Rect
): boolean {
  if (!segmentIntersectsRect(a, b, r)) {
    return true;
  }
  const [t0, t1] = [span.t0, span.t1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const nx = (-dy / len) * SEAM_TOLERANCE * outward;
  const ny = (dx / len) * SEAM_TOLERANCE * outward;
  const p: XY = [a[0] + dx * t0 + nx, a[1] + dy * t0 + ny];
  const q: XY = [a[0] + dx * t1 + nx, a[1] + dy * t1 + ny];
  const ts = crossings(p, q, polys);
  for (let k = 0; k + 1 < ts.length; k++) {
    const m = ((ts[k] as number) + (ts[k + 1] as number)) / 2;
    const x = p[0] + (q[0] - p[0]) * m;
    const y = p[1] + (q[1] - p[1]) * m;
    if (!polys.some((poly) => inPolygon(x, y, poly))) {
      return false;
    }
  }
  return true;
}

/** 0, 1 and every fraction along p→q where it crosses an edge of the areas, in order. */
function crossings(p: XY, q: XY, polys: readonly PolygonGeom[]): number[] {
  const [minX, maxX] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])];
  const [minY, maxY] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
  const ts = [0, 1];
  for (const poly of polys) {
    for (const ring of [poly.outer, ...poly.holes]) {
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const c = ring[j] as XY;
        const d = ring[i] as XY;
        if (
          Math.max(c[0], d[0]) < minX ||
          Math.min(c[0], d[0]) > maxX ||
          Math.max(c[1], d[1]) < minY ||
          Math.min(c[1], d[1]) > maxY
        ) {
          continue;
        }
        const t = crossingAt(p, q, c, d);
        if (t !== undefined) {
          ts.push(t);
        }
      }
    }
  }
  return ts.sort((x, y) => x - y);
}

/**
 * `areasCoverRect` across seams: every edge touching `r` that bounds its own
 * area on one side has the areas, within SEAM_TOLERANCE, on the other, so no
 * boundary of the union, seams aside, crosses `r`. Then an edge touching it
 * puts it inside the union; with none, its centre decides.
 */
function coverAcrossSeams(polys: readonly PolygonGeom[], r: Rect): boolean {
  let touched = false;
  for (const poly of polys) {
    for (const ring of [poly.outer, ...poly.holes]) {
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = ring[j] as XY;
        const b = ring[i] as XY;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len === 0 || !segmentIntersectsRect(a, b, r)) {
          continue;
        }
        const sides = interiorSides(a, b, len, poly);
        // An edge with area on both sides of its own, or on neither (a spike), bounds nothing.
        if (sides === LEFT || sides === RIGHT) {
          touched = true;
          if (!outsideCovered(a, b, len, sides === LEFT ? -1 : 1, polys, r)) {
            return false;
          }
        }
      }
    }
  }
  const cx = (r.minX + r.maxX) / 2;
  const cy = (r.minY + r.maxY) / 2;
  return touched || polys.some((poly) => inPolygon(cx, cy, poly));
}

/**
 * True only when the areas together cover the closed rectangle, gaps no
 * wider than SEAM_TOLERANCE aside. Where two polygons share each edge vertex
 * for vertex, every edge that touches the rectangle has area on both sides;
 * with no boundary of the union crossing the rectangle, its centre decides.
 * Otherwise each such edge is followed across, `SEAM_TOLERANCE` out, so an
 * edge split differently on each side, two areas that overlap, or a seam
 * narrower than that still cover. Callers read false as "not covered".
 */
export function areasCoverRect(geoms: readonly Geom[], r: Rect): boolean {
  const sides = new Map<string, number>();
  const polys = geoms.flatMap((g) => (g.type === "polygon" ? g.polygons : []));
  let shared = true;
  for (const poly of polys) {
    if (!collectEdges(poly, r, sides)) {
      shared = false;
      break;
    }
  }
  if (shared && [...sides.values()].every((s) => s === (LEFT | RIGHT))) {
    const cx = (r.minX + r.maxX) / 2;
    const cy = (r.minY + r.maxY) / 2;
    return polys.some((poly) => inPolygon(cx, cy, poly));
  }
  // One area alone has no seam: an edge of it touching the rectangle is the union's.
  return polys.length > 1 && coverAcrossSeams(polys, r);
}
