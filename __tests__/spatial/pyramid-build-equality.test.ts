import fc from "fast-check";
import path from "path";
import { tileAt, tileRect, toMercator } from "../../src/foundation/geo";
import type { Rect, XY } from "../../src/foundation/geo";
import type { Geom, PolygonGeom } from "../../src/foundation/geometry";
import { geomContainsRect, geomRectDistance, pointInPolygon } from "../../src/foundation/geometry";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { ChartFeature, DepthFeature } from "../../src/ingest/features";
import { boxAround } from "../../src/ingest/wfs";
import { boxRect } from "../../src/spatial/build-box";
import {
  FULL,
  indexPolygon,
  inPolygon,
  MISS,
  PARTIAL,
  polygonsContainRect,
  polygonsRectDistance,
  polygonsRectRelation
} from "../../src/spatial/polygon-index";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { serializePyramid } from "../../src/spatial/store";
import { fraction } from "../helpers/arbitraries";
import { FIXTURES } from "../helpers/fixture-index";
import { referenceBuildPyramid } from "../helpers/reference-pyramid-build";
import { coverage, point, quality } from "../helpers/synthetic";

/**
 * The build's indexed polygon tests (IX-1) are an exact speed-up: the same
 * nodes, byte for byte, as the builder that walked every vertex per tile.
 */

const CENTRE = toMercator(22.005, 60.005);
/** About 300 m of ground at 60° N. */
const RADIUS = 600;

/** A star-shaped ring around `c` with one vertex per radius fraction; never self-crossing. */
function star(c: XY, radius: number, fractions: number[], phase: number): XY[] {
  const n = fractions.length;
  return fractions.map((f, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    const r = radius * (0.45 + 0.55 * f);
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  });
}

const ringFractions = fc.array(fraction, { minLength: 64, maxLength: 400 });

const polygonArb = fc
  .record({
    dx: fraction,
    dy: fraction,
    scale: fc.double({ min: 0.2, max: 1, noNaN: true }),
    phase: fraction,
    outer: ringFractions,
    hole: fc.option(fc.array(fraction, { minLength: 3, maxLength: 120 }), { nil: undefined })
  })
  .map(({ dx, dy, scale, phase, outer, hole }): PolygonGeom => {
    const c: XY = [CENTRE[0] + (dx - 0.5) * RADIUS, CENTRE[1] + (dy - 0.5) * RADIUS];
    const r = RADIUS * scale;
    return {
      outer: star(c, r, outer, phase * Math.PI),
      // Inside the outer ring's inner radius (0.45 r), so the hole never crosses it.
      holes: hole ? [star(c, r * 0.4, hole, phase)] : []
    };
  });

const geomArb = fc
  .array(polygonArb, { minLength: 1, maxLength: 3 })
  .map((polygons): Geom => ({ type: "polygon", polygons }));

/** Tiles near the polygons at the zooms the build visits, plus rectangles on their vertices. */
function rectsFor(geom: Geom, picks: number[]): Rect[] {
  if (geom.type !== "polygon") {
    return [];
  }
  const vertices = geom.polygons.flatMap((p) => [...p.outer, ...p.holes.flat()]);
  return picks.flatMap((f, k) => {
    const v = vertices[Math.min(vertices.length - 1, Math.floor(f * vertices.length))] as XY;
    const z = 14 + (k % 7);
    const t = tileAt(z, v[0], v[1]);
    const w = 5 + 50 * f;
    // Off the vertex by up to a radius: inside, in a hole or clear of the area.
    const o = tileAt(z, v[0] + (f - 0.5) * RADIUS, v[1] + (((f * 13) % 1) - 0.5) * RADIUS);
    return [
      tileRect(z, t.x, t.y),
      tileRect(z, o.x, o.y),
      { minX: v[0], minY: v[1], maxX: v[0] + w, maxY: v[1] + w }
    ];
  });
}

describe("indexed polygon tests equal foundation/geometry.ts", () => {
  test("distance, containment and the one-pass relation, on many-vertex polygons", () => {
    fc.assert(
      fc.property(geomArb, fc.array(fraction, { minLength: 8, maxLength: 24 }), (geom, picks) => {
        if (geom.type !== "polygon") {
          return;
        }
        const shape = geom.polygons.map(indexPolygon);
        for (const r of rectsFor(geom, picks)) {
          for (const limit of [0, 3, 40, Infinity]) {
            expect(polygonsRectDistance(shape, r, limit)).toBe(geomRectDistance(geom, r, limit));
          }
          const contains = geomContainsRect(geom, r);
          expect(polygonsContainRect(shape, r)).toBe(contains);
          const touches = geomRectDistance(geom, r, 0) === 0;
          expect(polygonsRectRelation(shape, r)).toBe(contains ? FULL : touches ? PARTIAL : MISS);
        }
      }),
      { numRuns: 150 }
    );
  });

  test("point in polygon, at vertices and at random points", () => {
    fc.assert(
      fc.property(
        polygonArb,
        fc.array(fc.tuple(fraction, fraction), { maxLength: 40 }),
        (p, at) => {
          const ix = indexPolygon(p);
          const points: XY[] = [
            ...p.outer.slice(0, 20),
            ...at.map(([u, v]): XY => [
              CENTRE[0] + (u - 0.5) * 2 * RADIUS,
              CENTRE[1] + (v - 0.5) * 2 * RADIUS
            ])
          ];
          for (const q of points) {
            expect(inPolygon(q[0], q[1], ix)).toBe(pointInPolygon(q, p));
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

function depthArea(geom: Geom, depth: number, objectClass = "DEPARE"): DepthFeature {
  return {
    role: "depth",
    objectClass,
    geom,
    depth,
    hazard: false,
    dredged: false,
    cellRef: 0,
    band: 5
  };
}

const same = (
  features: ChartFeature[],
  opts: { minZoom: number; leafZoom: number; within?: Rect }
) =>
  expect(
    serializePyramid(buildPyramid(features, opts)).equals(
      serializePyramid(referenceBuildPyramid(features, opts))
    )
  ).toBe(true);

describe("pyramid build equals the reference builder", () => {
  test.each([16, 18, 20])("the fixture cells at leaf zoom %i", (leafZoom) => {
    const features = ["FI4SYNTH", "FI5SYNTH"].flatMap(
      (name, i) => readCellDirectory(path.join(FIXTURES, name), i).features
    );
    same(features, { minZoom: 10, leafZoom });
  });

  test.each([16, 18])(
    "the fixture cells in a box around the vessel at leaf zoom %i",
    (leafZoom) => {
      const features = ["FI4SYNTH", "FI5SYNTH"].flatMap(
        (name, i) => readCellDirectory(path.join(FIXTURES, name), i).features
      );
      const within = boxRect(boxAround([22.02, 60.01], 1));
      same(features, { minZoom: 10, leafZoom, within });
    }
  );

  test("random many-vertex areas, land, soundings and quality zones", () => {
    const box = [21.99, 59.995, 22.02, 60.015] as const;
    fc.assert(
      fc.property(
        fc.array(fc.tuple(geomArb, fc.integer({ min: -1, max: 20 })), {
          minLength: 1,
          maxLength: 4
        }),
        fc.array(fc.tuple(fraction, fraction, fc.integer({ min: 0, max: 15 })), { maxLength: 10 }),
        (areas, soundings) => {
          const features: ChartFeature[] = [
            coverage(box),
            quality([box[0], box[1], 22.005, box[3]], 2),
            depthArea(
              {
                type: "polygon",
                polygons: [
                  {
                    outer: [
                      toMercator(box[0], box[1]),
                      toMercator(box[2], box[1]),
                      toMercator(box[2], box[3]),
                      toMercator(box[0], box[3])
                    ],
                    holes: []
                  }
                ]
              },
              25
            ),
            ...areas.map(([g, d]) => (d < 0 ? depthArea(g, -Infinity, "LNDARE") : depthArea(g, d))),
            ...soundings.map(([u, v, d]) =>
              point(box[0] + u * (box[2] - box[0]), box[1] + v * (box[3] - box[1]), d, {
                objectClass: "SOUNDG"
              })
            )
          ];
          same(features, { minZoom: 12, leafZoom: 19 });
        }
      ),
      { numRuns: 25 }
    );
  });
});
