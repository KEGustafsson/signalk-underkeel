import fc from "fast-check";
import type { ChartFeature } from "../../src/ingest/features";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid, splitZoom } from "../../src/spatial/pyramid-build";
import type { Box } from "../helpers/synthetic";
import { area, coverage, land, point, quality } from "../helpers/synthetic";

/**
 * Tiles split no finer than 1 mm at the compilation scale of the cells in
 * them (plan §4.3): an overview cell's coastline is not cut into tiles
 * finer than it can place, and a tile that stops takes the shallowest depth
 * of all it holds, so it never reads deeper than a full-resolution build.
 */

const BOX: Box = [22.0, 60.0, 22.08, 60.04];
const scaled = (fs: ChartFeature[], scale: number): ChartFeature[] =>
  fs.map((f) => ({ ...f, scale }));

function chart(): ChartFeature[] {
  return [
    coverage(BOX),
    quality(BOX, 3),
    area(BOX, 12),
    area([22.01, 60.01, 22.03, 60.02], 3),
    land([22.05, 60.02, 22.06, 60.03]),
    point(22.04, 60.005, 1.5)
  ];
}

const deepest = (store: ReturnType<typeof buildPyramid>): number => {
  let z = store.minZoom;
  for (let k = store.minZoom; k <= store.leafZoom; k++) {
    for (const _ of store.entries(k)) {
      z = k;
      break;
    }
  }
  return z;
};

describe("splitting by compilation scale", () => {
  test("1 mm at the scale: 1:3 500 000 stops at z14, 1:12 000 needs the leaf zoom", () => {
    const at = (scale: number) => splitZoom({ ...coverage(BOX), scale });
    expect(at(3_500_000)).toBe(14);
    expect(at(45_000)).toBe(20);
    expect(at(12_000)).toBeGreaterThan(20);
    expect(splitZoom(coverage(BOX))).toBe(Infinity);
  });

  test("an overview cell's edges split no finer than its scale allows", () => {
    const opts = { minZoom: 10, leafZoom: 20 };
    expect(deepest(buildPyramid(chart(), opts))).toBe(20);
    expect(deepest(buildPyramid(scaled(chart(), 3_500_000), opts))).toBe(14);
  });

  test("a larger-scale cell over the overview splits as finely as it needs", () => {
    const harbour: Box = [22.0, 60.0, 22.02, 60.01];
    const features = [
      ...scaled(chart(), 3_500_000),
      ...scaled(
        [
          { ...coverage(harbour), band: 5 },
          { ...quality(harbour, 1), band: 5 },
          { ...area(harbour, 8), band: 5 },
          { ...area([22.005, 60.004, 22.006, 60.005], 1), band: 5 }
        ],
        12_000
      )
    ];
    expect(deepest(buildPyramid(features, { minZoom: 10, leafZoom: 20 }))).toBe(20);
  });

  test("never deeper than the full-resolution build, at any point (property)", () => {
    const full = buildPyramid(chart(), { minZoom: 10, leafZoom: 18 });
    const coarse = buildPyramid(scaled(chart(), 1_500_000), { minZoom: 10, leafZoom: 18 });
    fc.assert(
      fc.property(
        fc.double({ min: 22.0, max: 22.08, noNaN: true }),
        fc.double({ min: 60.0, max: 60.04, noNaN: true }),
        (lon, lat) => {
          const g = footprintGeom([[lon, lat]]);
          expect(minDepthOver(coarse, g).dMin).toBeLessThanOrEqual(minDepthOver(full, g).dMin);
        }
      ),
      { numRuns: 300 }
    );
  });
});
