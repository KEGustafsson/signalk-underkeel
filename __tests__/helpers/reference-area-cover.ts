import type { Rect, XY } from "../../src/foundation/geo";
import type { Geom, PolygonGeom, Ring } from "../../src/foundation/geometry";

/**
 * `areasCoverRect` as foundation/geometry.ts had it before area-cover.ts,
 * walking every edge of every area per rectangle, kept verbatim with the
 * ray cast and Liang–Barsky clip it read. The indexed build must decide
 * every tile's coverage as this does.
 */

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
function segmentIntersectsRect(a: XY, b: XY, r: Rect): boolean {
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
const SEAM_TOLERANCE = 0.5;

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
