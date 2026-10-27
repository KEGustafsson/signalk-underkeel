import type { Rect, XY } from "./geo";
import type { Geom, PolygonGeom } from "./geometry";
import { pointInPolygon, segmentIntersectsRect, segmentRectSpan } from "./geometry";

/** Whether areas together cover a rectangle, gaps of SEAM_TOLERANCE between them aside. */

/** Below this length (metres) an edge is not matched against its neighbours. */
const MIN_SHARED_EDGE = 1e-3;
/** Offset (metres) of the side probes from an edge's midpoint. */
const SIDE_PROBE = 1e-5;
const LEFT = 1;
const RIGHT = 2;

/**
 * An edge whose box lies farther than this (Mercator metres) from a rectangle
 * does not touch it: `segmentIntersectsRect` rounds past an edge's box by
 * about 1e-8 m.
 */
const TOUCH_MARGIN = 1e-3;

/**
 * The areas `areasCover` reads. Each edge handed over is tested as the walk
 * over all of them tests it, so an index that hands over only the edges near
 * a rectangle (spatial/polygon-index.ts) gives the same answer.
 */
export interface CoverAreas {
  readonly count: number;
  /** Inside area k's outer ring and outside its holes, as `pointInPolygon`. */
  inside(k: number, x: number, y: number): boolean;
  /**
   * Calls `each` with edges a→b of area k's rings, a the vertex before b, until
   * it returns false: every edge whose box comes within `margin` of `r`, maybe
   * others, none twice. `a` and `b` may be reused once `each` returns.
   */
  edgesNear(k: number, r: Rect, margin: number, each: (a: XY, b: XY) => boolean): void;
}

/** Which sides of edge a→b, a before b, lie inside area k: LEFT | RIGHT bits. */
function interiorSides(a: XY, b: XY, len: number, areas: CoverAreas, k: number): number {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = (-(b[1] - a[1]) / len) * SIDE_PROBE;
  const ny = ((b[0] - a[0]) / len) * SIDE_PROBE;
  return (
    (areas.inside(k, mx + nx, my + ny) ? LEFT : 0) | (areas.inside(k, mx - nx, my - ny) ? RIGHT : 0)
  );
}

/**
 * Adds the sides of every edge of area k that touches `r` to `sides`, keyed
 * by the edge with its endpoints in lexicographic order. False when an edge
 * is too short to probe.
 */
function collectEdges(areas: CoverAreas, k: number, r: Rect, sides: Map<string, number>): boolean {
  let probed = true;
  areas.edgesNear(k, r, TOUCH_MARGIN, (p, q) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len === 0 || !segmentIntersectsRect(p, q, r)) {
      return true;
    }
    if (len < MIN_SHARED_EDGE) {
      probed = false;
      return false;
    }
    const [a, b] = p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? [p, q] : [q, p];
    const key = `${a[0]},${a[1]},${b[0]},${b[1]}`;
    sides.set(key, (sides.get(key) ?? 0) | interiorSides(a, b, len, areas, k));
    return true;
  });
  return probed;
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

function someInside(areas: CoverAreas, x: number, y: number): boolean {
  for (let k = 0; k < areas.count; k++) {
    if (areas.inside(k, x, y)) {
      return true;
    }
  }
  return false;
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
  areas: CoverAreas,
  r: Rect
): boolean {
  const span = segmentRectSpan(a, b, r);
  if (!span) {
    return true;
  }
  const [t0, t1] = span;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const nx = (-dy / len) * SEAM_TOLERANCE * outward;
  const ny = (dx / len) * SEAM_TOLERANCE * outward;
  const p: XY = [a[0] + dx * t0 + nx, a[1] + dy * t0 + ny];
  const q: XY = [a[0] + dx * t1 + nx, a[1] + dy * t1 + ny];
  const ts = crossings(p, q, areas);
  for (let k = 0; k + 1 < ts.length; k++) {
    const m = ((ts[k] as number) + (ts[k + 1] as number)) / 2;
    const x = p[0] + (q[0] - p[0]) * m;
    const y = p[1] + (q[1] - p[1]) * m;
    if (!someInside(areas, x, y)) {
      return false;
    }
  }
  return true;
}

/** 0, 1 and every fraction along p→q where it crosses an edge of the areas, in order. */
function crossings(p: XY, q: XY, areas: CoverAreas): number[] {
  const box: Rect = {
    minX: Math.min(p[0], q[0]),
    minY: Math.min(p[1], q[1]),
    maxX: Math.max(p[0], q[0]),
    maxY: Math.max(p[1], q[1])
  };
  const ts = [0, 1];
  for (let k = 0; k < areas.count; k++) {
    areas.edgesNear(k, box, 0, (c, d) => {
      if (
        Math.max(c[0], d[0]) >= box.minX &&
        Math.min(c[0], d[0]) <= box.maxX &&
        Math.max(c[1], d[1]) >= box.minY &&
        Math.min(c[1], d[1]) <= box.maxY
      ) {
        const t = crossingAt(p, q, c, d);
        if (t !== undefined) {
          ts.push(t);
        }
      }
      return true;
    });
  }
  return ts.sort((x, y) => x - y);
}

/**
 * `areasCover` across seams: every edge touching `r` that bounds its own
 * area on one side has the areas, within SEAM_TOLERANCE, on the other, so no
 * boundary of the union, seams aside, crosses `r`. Then an edge touching it
 * puts it inside the union; with none, its centre decides.
 */
function coverAcrossSeams(areas: CoverAreas, r: Rect): boolean {
  // Gathered first: `outsideCovered` walks the areas' edges again.
  const bounds: { a: XY; b: XY; len: number; outward: number }[] = [];
  for (let k = 0; k < areas.count; k++) {
    areas.edgesNear(k, r, TOUCH_MARGIN, (a, b) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len === 0 || !segmentIntersectsRect(a, b, r)) {
        return true;
      }
      const sides = interiorSides(a, b, len, areas, k);
      // An edge with area on both sides of its own, or on neither (a spike), bounds nothing.
      if (sides === LEFT || sides === RIGHT) {
        bounds.push({ a: [a[0], a[1]], b: [b[0], b[1]], len, outward: sides === LEFT ? -1 : 1 });
      }
      return true;
    });
  }
  for (const { a, b, len, outward } of bounds) {
    if (!outsideCovered(a, b, len, outward, areas, r)) {
      return false;
    }
  }
  return bounds.length > 0 || someInside(areas, (r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2);
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
export function areasCover(areas: CoverAreas, r: Rect): boolean {
  const sides = new Map<string, number>();
  let shared = true;
  for (let k = 0; k < areas.count && shared; k++) {
    shared = collectEdges(areas, k, r, sides);
  }
  if (shared && [...sides.values()].every((s) => s === (LEFT | RIGHT))) {
    return someInside(areas, (r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2);
  }
  // One area alone has no seam: an edge of it touching the rectangle is the union's.
  return areas.count > 1 && coverAcrossSeams(areas, r);
}

/** The polygons as `areasCover` reads them, every edge walked. */
function walkedAreas(polys: readonly PolygonGeom[]): CoverAreas {
  return {
    count: polys.length,
    inside: (k, x, y) => pointInPolygon([x, y], polys[k] as PolygonGeom),
    edgesNear: (k, _r, _margin, each) => {
      const poly = polys[k] as PolygonGeom;
      for (const ring of [poly.outer, ...poly.holes]) {
        const n = ring.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          if (!each(ring[j] as XY, ring[i] as XY)) {
            return;
          }
        }
      }
    }
  };
}

/** `areasCover` over the polygons of `geoms`. */
export function areasCoverRect(geoms: readonly Geom[], r: Rect): boolean {
  const polys = geoms.flatMap((g) => (g.type === "polygon" ? g.polygons : []));
  return areasCover(walkedAreas(polys), r);
}
