import fc from "fast-check";
import { toMercator } from "../../src/foundation/geo";
import type { Rect, XY } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import type { DepthFeature } from "../../src/ingest/features";
import { HazardIndex } from "../../src/spatial/hazards";
import { fraction } from "../helpers/arbitraries";
import { ReferenceHazardIndex } from "../helpers/reference-hazards";

/**
 * The packed hazard tree (IX-9) finds the same hazards at the same distances
 * as the object tree it replaced, across the antimeridian too.
 */

// Near 180° E so a query reaching past it searches the other end of the world.
const W = 179.9;
const SPAN = 0.2;

const at = (u: number, v: number): XY => {
  const lon = W + u * SPAN;
  return toMercator(lon > 180 ? lon - 360 : lon, 60 + v * 0.05);
};

function hazard(i: number, geom: Geom, depth: number): DepthFeature {
  return {
    role: "depth",
    objectClass: geom.type === "point" ? "SOUNDG" : "OBSTRN",
    geom,
    depth,
    hazard: true,
    dredged: false,
    lnam: `H${i}`,
    cellRef: 0,
    band: 5
  };
}

const featureArb = fc.oneof(
  fc.tuple(fraction, fraction, fc.integer({ min: 0, max: 8 })).map(
    ([u, v, d]) =>
      (i: number) =>
        hazard(i, { type: "point", p: at(u, v) }, d)
  ),
  fc
    .tuple(
      fc.array(fc.tuple(fraction, fraction), { minLength: 2, maxLength: 6 }),
      fc.integer({ min: 0, max: 8 })
    )
    .map(
      ([pts, d]) =>
        (i: number) =>
          hazard(i, { type: "line", coords: pts.map(([u, v]) => at(u, v)) }, d)
    )
);

const sortedHits = (hits: { feature: DepthFeature; distance: number }[]) =>
  hits
    .map((h) => [h.feature.lnam, h.distance])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe("packed hazard tree", () => {
  test("search and near equal the object tree's", () => {
    fc.assert(
      fc.property(
        fc.array(featureArb, { maxLength: 300 }),
        fc.integer({ min: 2, max: 20 }),
        fc.array(fc.tuple(fraction, fraction, fraction, fc.integer({ min: 0, max: 3000 })), {
          minLength: 1,
          maxLength: 20
        }),
        (makers, nodeSize, queries) => {
          const features = makers.map((m, i) => m(i));
          const tree = new HazardIndex(features, nodeSize);
          const ref = new ReferenceHazardIndex(features, nodeSize);
          expect(tree.size).toBe(ref.size);
          expect(tree.features).toBe(features);
          for (const [u, v, w, buffer] of queries) {
            const a = at(u, v);
            const r: Rect = {
              minX: a[0],
              minY: a[1],
              maxX: a[0] + w * 5000,
              maxY: a[1] + w * 3000
            };
            expect([...tree.search(r)].sort((x, y) => x - y)).toEqual(
              [...ref.search(r)].sort((x, y) => x - y)
            );
            const geom: Geom = { type: "point", p: a };
            const hits = tree.near(geom, buffer);
            const want = ref.near(geom, buffer);
            expect(sortedHits(hits)).toEqual(sortedHits(want));
            // Shallowest first, then nearest, as before.
            expect(hits.map((h) => [h.feature.depth, h.distance])).toEqual(
              want.map((h) => [h.feature.depth, h.distance])
            );
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  test("an empty tree finds nothing", () => {
    const tree = new HazardIndex([]);
    expect(tree.search({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 })).toEqual([]);
    expect(tree.near({ type: "point", p: [0, 0] }, 1e6)).toEqual([]);
  });
});
