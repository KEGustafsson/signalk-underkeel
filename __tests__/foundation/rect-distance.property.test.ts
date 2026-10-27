import fc from "fast-check";
import type { Rect, XY } from "../../src/foundation/geo";
import { tileAt, tileRect } from "../../src/foundation/geo";
import type { Geom, PolygonGeom } from "../../src/foundation/geometry";
import {
  geomRectDistance,
  measuredRectDistance,
  measureGeom,
  segmentRectDistance
} from "../../src/foundation/geometry";
import { fraction, uniform } from "../helpers/arbitraries";
import {
  referenceGeomRectDistance,
  referenceSegmentRectDistance
} from "../helpers/reference-graded-walk";

/**
 * The rectangle distances skip the edges and the ray casts whose result
 * cannot change the answer, and the walk reads them from edges laid out
 * once (`measuredRectDistance`). Both must return what the 118913f
 * distance returns, bit for bit, at every limit: the walk's weights read
 * the distance, and one rounded farther would weigh a tile less.
 */

/** Footprint-sized and chart-sized shapes, near the equator, at 60° N and one world over. */
const centreArb = fc.constantFrom<XY>(
  [2449300, 8400550],
  [-1e5, 3e5],
  [593005, 7018740],
  [2449300 + 40075016.68557849, 8400550],
  [20037000, -8400550]
);

/** A convex hull, as the look-ahead's footprints are, or a jagged star with an optional hole. */
const ringArb = fc.record({
  radii: fc.array(uniform(0.01, 400), { minLength: 1, maxLength: 24 }),
  phase: fraction,
  jagged: fc.boolean(),
  hole: fc.boolean()
});

function ring(c: XY, radii: number[], phase: number, jagged: boolean): XY[] {
  const n = radii.length;
  const r = jagged ? radii : radii.map(() => radii[0] as number);
  return r.map((rad, i): XY => {
    const a = 2 * Math.PI * (phase + i / n);
    return [c[0] + rad * Math.cos(a), c[1] + rad * Math.sin(a)];
  });
}

const geomArb = fc
  .tuple(
    centreArb,
    fc.constantFrom("polygon", "line", "point"),
    fc.array(ringArb, { minLength: 1, maxLength: 3 })
  )
  .map(([c, type, rings]): Geom => {
    const first = rings[0] as (typeof rings)[number];
    if (type === "point") {
      return { type: "point", p: c };
    }
    if (type === "line") {
      return { type: "line", coords: ring(c, first.radii, first.phase, first.jagged) };
    }
    const polygons = rings.map((g, k): PolygonGeom => {
      const at: XY = [c[0] + 900 * k, c[1]];
      const outer = ring(at, g.radii, g.phase, g.jagged);
      const inner = Math.min(...g.radii) * 0.3;
      return { outer, holes: g.hole ? [ring(at, [inner, inner, inner], g.phase, false)] : [] };
    });
    return { type: "polygon", polygons };
  });

function vertices(g: Geom): XY[] {
  if (g.type === "point") {
    return [g.p];
  }
  return g.type === "line"
    ? [...g.coords]
    : g.polygons.flatMap((p) => [...p.outer, ...p.holes.flat()]);
}

/**
 * Tiles near the shape at zooms 10–24, rectangles with a corner or a side on
 * its vertices, and rectangles with a corner just inside a vertex, where the
 * ray cast decides.
 */
function rectsFor(g: Geom, picks: number[]): Rect[] {
  const vs = vertices(g);
  const cx = vs.reduce((s, v) => s + v[0], 0) / vs.length;
  const cy = vs.reduce((s, v) => s + v[1], 0) / vs.length;
  return picks.flatMap((f, k) => {
    const v = vs[Math.floor(f * vs.length) % vs.length] as XY;
    const z = 10 + (k % 15);
    const off = (f - 0.5) * 3000;
    const t = tileAt(z, v[0] + off, v[1] - off / 2);
    const w = 50 * f;
    const ix = v[0] + (cx - v[0]) * (1e-5 + f * 0.002);
    const iy = v[1] + (cy - v[1]) * (1e-5 + f * 0.002);
    const e = 1e-3 * f;
    return [
      tileRect(z, t.x, t.y),
      { minX: v[0], minY: v[1], maxX: v[0] + w, maxY: v[1] + w },
      { minX: v[0] - w, minY: v[1] - 2 * w, maxX: v[0], maxY: v[1] + w },
      { minX: v[0] + off, minY: v[1], maxX: v[0] + off, maxY: v[1] },
      { minX: ix, minY: iy, maxX: ix + w, maxY: iy + w },
      { minX: ix - w, minY: iy - w, maxX: ix, maxY: iy },
      { minX: ix - e, minY: iy - e, maxX: ix, maxY: iy },
      { minX: ix, minY: iy, maxX: ix + e, maxY: iy + e }
    ];
  });
}

describe("rectangle distances equal the 118913f distance", () => {
  test("geomRectDistance and measuredRectDistance, at every limit", () => {
    fc.assert(
      fc.property(
        geomArb,
        fc.array(fraction, { minLength: 4, maxLength: 16 }),
        uniform(0, 3000),
        (g, picks, l) => {
          const measured = measureGeom(g);
          const bad: Array<{
            r: Rect;
            limit: number;
            want: number;
            got: number;
            measured: number;
          }> = [];
          for (const r of rectsFor(g, picks)) {
            const exact = referenceGeomRectDistance(g, r);
            for (const limit of [0, l, exact, Infinity]) {
              const want = referenceGeomRectDistance(g, r, limit);
              const got = geomRectDistance(g, r, limit);
              const m = measuredRectDistance(measured, r, limit);
              if (!Object.is(got, want) || !Object.is(m, want)) {
                bad.push({ r, limit, want, got, measured: m });
              }
            }
          }
          // One assertion per run, not per rectangle (§7 Test runtime).
          expect(bad.slice(0, 5)).toEqual([]);
        }
      ),
      { numRuns: 300 }
    );
  });

  test("segmentRectDistance", () => {
    fc.assert(
      fc.property(geomArb, fc.array(fraction, { minLength: 4, maxLength: 16 }), (g, picks) => {
        const vs = vertices(g);
        const bad = rectsFor(g, picks).flatMap((r) =>
          vs.flatMap((a, i) => {
            const b = vs[(i + 1) % vs.length] as XY;
            const want = referenceSegmentRectDistance(a, b, r);
            const got = segmentRectDistance(a, b, r);
            return Object.is(got, want) ? [] : [{ a, b, r, want, got }];
          })
        );
        expect(bad.slice(0, 5)).toEqual([]);
      }),
      { numRuns: 200 }
    );
  });
});
