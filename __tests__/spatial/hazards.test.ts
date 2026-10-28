import fc from "fast-check";
import { toMercator } from "../../src/foundation/geo";
import type { Rect, XY } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import type { DepthFeature } from "../../src/ingest/features";
import { readHazards, serializeHazards } from "../../src/spatial/hazard-file";
import { HazardIndex } from "../../src/spatial/hazards";
import { fraction } from "../helpers/arbitraries";
import { PackedHazardIndex } from "../helpers/packed-hazards";

/**
 * The column index, built from features or read back from `hazards.bin`,
 * finds the same hazards at the same distances in the same order as the
 * packed tree of feature objects it replaced, across the antimeridian too,
 * with every depth as it was given.
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
    // A multipoint sounding's points share one LNAM.
    lnam: `H${i % 7}`,
    cellRef: i % 3,
    band: 5
  };
}

/**
 * Depths of one kind per run, so each storage is exercised: centimetres
 * within 16 bits, centimetres past them, and depths no centimetre count
 * gives exactly. Some are land, and many share a few whole metres, so
 * equal depths at equal distances come up.
 */
const depthArb = (kind: string): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant(-Infinity) },
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 3 }) },
    {
      weight: 3,
      arbitrary:
        kind === "cm16"
          ? fc.integer({ min: -300, max: 900 }).map((cm) => cm / 100)
          : kind === "cm32"
            ? fc.integer({ min: -100, max: 2_000_000 }).map((cm) => cm / 100)
            : fc.double({ min: -50, max: 900, noNaN: true }).filter((d) => !Object.is(d, -0))
    }
  );

// Positions on a coarse grid, so duplicates and equal distances are common.
const cell = fc.integer({ min: 0, max: 12 }).map((k) => k / 12);

const featureArb = (depth: fc.Arbitrary<number>) =>
  fc.oneof(
    {
      weight: 6,
      arbitrary: fc.tuple(cell, cell, depth).map(
        ([u, v, d]) =>
          (i: number) =>
            hazard(i, { type: "point", p: at(u, v) }, d)
      )
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.array(fc.tuple(fraction, fraction), { minLength: 2, maxLength: 6 }), depth)
        .map(
          ([pts, d]) =>
            (i: number) =>
              hazard(i, { type: "line", coords: pts.map(([u, v]) => at(u, v)) }, d)
        )
    },
    {
      weight: 1,
      arbitrary: fc.tuple(cell, cell, depth).map(([u, v, d]) => (i: number) => {
        const ring = [at(u, v), at(u + 0.02, v), at(u + 0.02, v + 0.03), at(u, v + 0.03)];
        return hazard(i, { type: "polygon", polygons: [{ outer: ring, holes: [] }] }, d);
      })
    }
  );

const setArb = fc
  .constantFrom("cm16", "cm32", "f64")
  .chain((kind) => fc.array(featureArb(depthArb(kind)), { maxLength: 300, size: "max" }));

const hits = (index: { near: PackedHazardIndex["near"] }, geom: Geom, buffer: number) =>
  index.near(geom, buffer).map((h) => [h.feature, h.distance]);

describe("hazard column index", () => {
  test("near and search equal the packed tree's, built or read back", () => {
    fc.assert(
      fc.property(
        setArb,
        fc.integer({ min: 2, max: 20 }),
        fc.array(fc.tuple(fraction, fraction, fraction, fc.integer({ min: 0, max: 3000 })), {
          minLength: 1,
          maxLength: 20
        }),
        (makers, nodeSize, queries) => {
          const features = makers.map((m, i) => m(i));
          const built = new HazardIndex(features, nodeSize);
          const read = readHazards(serializeHazards(built));
          const want = new PackedHazardIndex(features, nodeSize);
          const got: unknown[] = [];
          const expected: unknown[] = [];
          const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
          for (const [u, v, w, buffer] of queries) {
            const a = at(u, v);
            const r: Rect = {
              minX: a[0],
              minY: a[1],
              maxX: a[0] + w * 5000,
              maxY: a[1] + w * 3000
            };
            const geoms: Geom[] = [
              { type: "point", p: a },
              { type: "line", coords: [a, at(u + w * 0.05, v)] }
            ];
            for (const index of [built, read]) {
              got.push(sorted(index.search(r)), ...geoms.map((g) => hits(index, g, buffer)));
              expected.push(sorted(want.search(r)), ...geoms.map((g) => hits(want, g, buffer)));
            }
          }
          got.push(built.size, read.size, built.features(), read.features());
          expected.push(features.length, features.length, features, features);
          expect(got).toEqual(expected);
        }
      ),
      { numRuns: 150 }
    );
  });

  test("a depth not exact in centimetres is kept as given, never rounded", () => {
    const depths = [1.234, 0.1 + 0.2, 2.345, 3.005, 5.5, -Infinity];
    const features = depths.map((d, i) => hazard(i, { type: "point", p: at(0.5, 0.5) }, d));
    const index = readHazards(serializeHazards(new HazardIndex(features)));
    const found = index.near({ type: "point", p: at(0.5, 0.5) }, 10).map((h) => h.feature.depth);
    expect(found).toEqual([...depths].sort((a, b) => a - b));
    expect(index.features().map((f) => f.depth)).toEqual(depths);
  });

  test("land, NaN and +∞ depths read as land, as hazards.json saved them", () => {
    const features = [NaN, Infinity, -Infinity, 2].map((d, i) =>
      hazard(i, { type: "point", p: at(0.5, 0.5) }, d)
    );
    expect(new HazardIndex(features).features().map((f) => f.depth)).toEqual([
      -Infinity,
      -Infinity,
      -Infinity,
      2
    ]);
  });

  test("an empty index finds nothing and reads back empty", () => {
    const index = readHazards(serializeHazards(new HazardIndex([])));
    expect(index.size).toBe(0);
    expect(index.search({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 })).toEqual([]);
    expect(index.near({ type: "point", p: [0, 0] }, 1e6)).toEqual([]);
  });
});

describe("hazards.bin", () => {
  const features = Array.from({ length: 40 }, (_, i) =>
    hazard(
      i,
      i % 10 === 0
        ? { type: "line", coords: [at(i / 40, 0.1), at(i / 40, 0.2)] }
        : { type: "point", p: at(i / 40, 0.5) },
      i % 4 === 0 ? -Infinity : i / 10
    )
  );
  const file = serializeHazards(new HazardIndex(features));

  test("reads back what was written, at any alignment", () => {
    const shifted = new Uint8Array(file.length + 3).subarray(3);
    shifted.set(file);
    expect(readHazards(shifted).features()).toEqual(features);
  });

  test("any changed bit, a short or a long file is refused, never read as fewer hazards", () => {
    const accepted: string[] = [];
    for (let i = 0; i < file.length; i++) {
      for (const bit of [0x01, 0x80]) {
        const bad = file.slice();
        bad[i] = (bad[i] as number) ^ bit;
        try {
          readHazards(bad);
          accepted.push(`byte ${i} bit ${bit}`);
        } catch {
          // refused
        }
      }
    }
    for (const length of [0, 1, 40, file.length - 8, file.length - 1]) {
      expect(() => readHazards(file.subarray(0, length))).toThrow();
    }
    const long = new Uint8Array(file.length + 8);
    long.set(file);
    expect(() => readHazards(long)).toThrow("corrupt");
    expect(accepted).toEqual([]);
  });
});
