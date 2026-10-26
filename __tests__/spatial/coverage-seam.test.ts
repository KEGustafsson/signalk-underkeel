import { toMercator } from "../../src/foundation/geo";
import type { LonLat } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import type { ChartFeature } from "../../src/ingest/features";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { Box } from "../helpers/synthetic";
import { area, basin, boxRing, coverage, quality } from "../helpers/synthetic";

const OPTS = { minZoom: 12, leafZoom: 18 };
const WEST: Box = [22.0, 60.0, 22.01, 60.01];
const EAST: Box = [22.01, 60.0, 22.02, 60.01];

describe("coverage seams between cells of one band", () => {
  const store = buildPyramid([...basin(WEST, 10), ...basin(EAST, 10, { cellRef: 1 })], OPTS);

  test("a footprint on the shared edge is covered", () => {
    const r = minDepthOver(store, footprintGeom([[22.01, 60.005]]));
    expect(r.dMin).toBe(10);
    expect(r.flags).toBe(0);
  });

  test("a footprint straddling the shared edge is covered", () => {
    const r = minDepthOver(store, footprintGeom(boxRing([22.0095, 60.004, 22.0105, 60.006])));
    expect(r.dMin).toBe(10);
    expect(r.flags & FLAGS.NO_COVERAGE).toBe(0);
  });

  test("a gap between two cells is still no coverage", () => {
    const gapped = buildPyramid(
      [...basin(WEST, 10), ...basin([22.0101, 60.0, 22.02, 60.01], 10, { cellRef: 1 })],
      OPTS
    );
    // The 5 m gap lies inside one leaf, which keeps the charted depth beside it.
    const r = minDepthOver(gapped, footprintGeom([[22.01005, 60.005]]));
    expect(r.flags & FLAGS.NO_COVERAGE).toBeTruthy();
  });
});

/** A polygon through the given lon/lat vertices. */
const ring = (pts: LonLat[]): Geom => ({
  type: "polygon",
  polygons: [{ outer: pts.map(([lon, lat]) => toMercator(lon, lat)), holes: [] }]
});

/** 1 cm of longitude at 60°N, about. */
const CM = 1 / (111320 * Math.cos(Math.PI / 3) * 100);

/**
 * Cells and quality zones that meet along one line in the source but are
 * drawn with their vertices split differently along it, or a few
 * centimetres apart (plan §4.3, SEAM_TOLERANCE), as Rijkswaterstaat's Inland
 * ENC cells 1R7WAD07 and 1R7WAD10 and their CATZOC zones do.
 */
describe("seams drawn differently on each side", () => {
  /** The east cell's west edge: x(lat) along the seam, split at 60.005. */
  const east = (x: (lat: number) => number): ChartFeature[] => {
    const geom = ring([
      [x(60.0), 60.0],
      [22.02, 60.0],
      [22.02, 60.01],
      [x(60.01), 60.01],
      [x(60.005), 60.005]
    ]);
    return [
      { ...coverage(EAST, { cellRef: 1 }), geom },
      { ...quality(EAST, 1, { cellRef: 1 }), geom },
      { ...area(EAST, 10, { cellRef: 1 }), geom }
    ];
  };
  const along = (x: (lat: number) => number) =>
    buildPyramid([...basin(WEST, 10), ...east(x)], OPTS);
  const across = (store: ReturnType<typeof buildPyramid>) =>
    [60.001, 60.003, 60.005, 60.007, 60.009].map((lat) =>
      minDepthOver(store, footprintGeom([[22.01, lat]]), { bufferMetres: 5 })
    );

  test("an extra vertex on one side leaves the seam covered and assessed", () => {
    const results = across(along(() => 22.01));
    expect(results.map((r) => r.flags)).toEqual([0, 0, 0, 0, 0]);
    expect(results.map((r) => r.dMin)).toEqual([10, 10, 10, 10, 10]);
  });

  test("a sliver of a few centimetres is a seam, not a gap", () => {
    // The east cell's edge bows 3 cm east of the west cell's at its middle vertex.
    const results = across(along((lat) => (lat === 60.005 ? 22.01 + 3 * CM : 22.01)));
    expect(results.map((r) => r.flags & (FLAGS.NO_COVERAGE | FLAGS.UNASSESSED))).toEqual([
      0, 0, 0, 0, 0
    ]);
  });

  test("a gap of a metre is still no coverage", () => {
    const results = across(along(() => 22.01 + 100 * CM));
    expect(results.every((r) => (r.flags & FLAGS.NO_COVERAGE) !== 0)).toBe(true);
  });
});
