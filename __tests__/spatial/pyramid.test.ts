import { FLAGS } from "../../src/spatial/node-store";
import { minDepthOver, footprintGeom } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { Box } from "../helpers/synthetic";
import { toMercator } from "../../src/foundation/geo";
import type { DepthFeature } from "../../src/ingest/features";
import { area, basin, boxRing, coverage, land, point, quality, swept } from "../helpers/synthetic";

const AREA: Box = [22.0, 60.0, 22.02, 60.01];
const OPTS = { minZoom: 12, leafZoom: 18 };

function query(store: ReturnType<typeof buildPyramid>, box: Box, bufferMetres = 0) {
  return minDepthOver(store, footprintGeom(boxRing(box)), { bufferMetres });
}

describe("min-depth pyramid", () => {
  test("a uniform basin answers its depth with A1 sigmas", () => {
    const store = buildPyramid(basin(AREA, 7), OPTS);
    const r = query(store, [22.005, 60.002, 22.006, 60.003]);
    expect(r.dMin).toBe(7);
    expect(r.flags).toBe(0);
    expect(r.sigmaP).toBe(2.5);
    expect(r.sigmaD).toBeCloseTo((0.5 + 0.07) / 2, 6);
    expect(r.cellRef).toBe(0);
  });

  test("a uniform area is stored without subdividing", () => {
    const store = buildPyramid(basin([22.0, 60.0, 22.4, 60.2], 7), { minZoom: 12, leafZoom: 20 });
    // Only edge tiles of the basin split; interior tiles stay at coarse zooms.
    expect(store.count).toBeLessThan(20000);
  });

  test("outside the chart is no coverage, never a depth", () => {
    const store = buildPyramid(basin(AREA, 7), OPTS);
    const r = query(store, [23.0, 61.0, 23.001, 61.001]);
    expect(r.dMin).toBe(-Infinity);
    expect(r.flags & FLAGS.NO_COVERAGE).toBeTruthy();
  });

  test("a point hazard is burned around its position", () => {
    const rock = point(22.01, 60.005, 1.2, { lnam: "ROCK" });
    const store = buildPyramid([...basin(AREA, 7), rock], OPTS);
    // A1 σP = 2.5 m, k = 2 → burned within 5 m; a footprint 3 m east still sees it.
    const east = 22.01 + 3 / (111320 * Math.cos((60 * Math.PI) / 180));
    expect(minDepthOver(store, footprintGeom([[east, 60.005]])).dMin).toBe(1.2);
    expect(query(store, [22.001, 60.001, 22.002, 60.002]).dMin).toBe(7);
  });

  test("the query buffer reaches hazards beyond the footprint", () => {
    const rock = point(22.01, 60.005, 1.2);
    const store = buildPyramid([...basin(AREA, 7), rock], OPTS);
    const footprint = footprintGeom([[22.01, 60.0055]]); // ~56 m north
    expect(minDepthOver(store, footprint, { bufferMetres: 10 }).dMin).toBe(7);
    expect(minDepthOver(store, footprint, { bufferMetres: 80 }).dMin).toBe(1.2);
  });

  test("a coastline marks the tiles it crosses, without a burn disc around it", () => {
    const coast: DepthFeature = {
      ...land([22.01, 60.004, 22.0101, 60.0041]),
      objectClass: "COALNE",
      hazard: true,
      geom: {
        type: "line",
        coords: [toMercator(22.01, 60.0), toMercator(22.01, 60.01)]
      }
    };
    // Unassessed quality would give a 1 km burn disc; a line gets none.
    const store = buildPyramid([coverage(AREA), area(AREA, 7), coast], OPTS);
    expect(query(store, [22.0099, 60.004, 22.0101, 60.005]).dMin).toBe(-Infinity);
    expect(query(store, [22.002, 60.004, 22.004, 60.005]).dMin).toBe(7);
  });

  test("land is -Infinity", () => {
    const store = buildPyramid([...basin(AREA, 7), land([22.01, 60.004, 22.012, 60.006])], OPTS);
    expect(query(store, [22.0105, 60.0045, 22.011, 60.005]).dMin).toBe(-Infinity);
  });

  test("swept areas flag SWEPT and use σD 0.1 m", () => {
    const fairway: Box = [22.0, 60.004, 22.02, 60.006];
    const store = buildPyramid([...basin(AREA, 12), swept(fairway, 8)], OPTS);
    const r = query(store, [22.005, 60.0048, 22.006, 60.0052]);
    expect(r.dMin).toBe(8);
    expect(r.flags & FLAGS.SWEPT).toBeTruthy();
    expect(r.sigmaD).toBeCloseTo(0.1, 6);
  });

  test("a rock inside a swept fairway still sets the depth", () => {
    const fairway: Box = [22.0, 60.004, 22.02, 60.006];
    const rock = point(22.01, 60.005, 3.5);
    const store = buildPyramid([...basin(AREA, 12), swept(fairway, 8), rock], OPTS);
    expect(query(store, [22.0095, 60.0048, 22.0105, 60.0052]).dMin).toBe(3.5);
  });

  test("areas without a quality zone are UNASSESSED with 2×C sigmas", () => {
    const store = buildPyramid([coverage(AREA), area(AREA, 6)], OPTS);
    const r = query(store, [22.005, 60.002, 22.006, 60.003]);
    expect(r.flags & FLAGS.UNASSESSED).toBeTruthy();
    expect(r.sigmaP).toBe(500);
  });

  test("dredged areas set DREDGED", () => {
    const features = [coverage(AREA), quality(AREA, 2), area(AREA, 4.5, { dredged: true })];
    const r = query(buildPyramid(features, OPTS), [22.005, 60.002, 22.006, 60.003]);
    expect(r.flags & FLAGS.DREDGED).toBeTruthy();
    expect(r.dMin).toBe(4.5);
  });

  test("a footprint across the coverage edge keeps the charted part's depth", () => {
    const store = buildPyramid([...basin(AREA, 7), point(22.0195, 60.005, 1.2)], OPTS);
    const r = query(store, [22.019, 60.0045, 22.021, 60.0055]);
    expect(r.dMin).toBe(-Infinity);
    expect(r.flags & FLAGS.NO_COVERAGE).toBeTruthy();
    expect(r.coveredDMin).toBe(1.2);
    expect(query(store, [23, 61, 23.001, 61.001]).coveredDMin).toBe(Infinity);
  });

  test("a coverage gap inside the extent is NO_COVERAGE", () => {
    const features = [
      ...basin([22.0, 60.0, 22.008, 60.01], 7),
      ...basin([22.012, 60.0, 22.02, 60.01], 7)
    ];
    const store = buildPyramid(features, OPTS);
    const r = query(store, [22.009, 60.004, 22.011, 60.005]);
    expect(r.flags & FLAGS.NO_COVERAGE).toBeTruthy();
    expect(r.dMin).toBe(-Infinity);
  });

  test("the larger usage band wins where bands overlap; the smaller fills gaps", () => {
    const coarse = basin([21.99, 59.99, 22.03, 60.02], 3, { band: 3, cellRef: 1 });
    const fine = basin(AREA, 9, { band: 5, cellRef: 0 });
    const store = buildPyramid([...coarse, ...fine], OPTS);
    const inside = query(store, [22.005, 60.002, 22.006, 60.003]);
    expect(inside.dMin).toBe(9);
    expect(inside.cellRef).toBe(0);
    const gap = query(store, [21.995, 59.995, 21.996, 59.996]);
    expect(gap.dMin).toBe(3);
    expect(gap.cellRef).toBe(1);
  });

  test("clearAbove stops at a deep enough bound and stays conservative", () => {
    const store = buildPyramid([...basin(AREA, 7), point(22.01, 60.005, 1.2)], OPTS);
    const box: Box = [22.001, 60.001, 22.019, 60.009];
    const full = query(store, box);
    const early = minDepthOver(store, footprintGeom(boxRing(box)), { clearAbove: 0 });
    expect(full.dMin).toBe(1.2);
    expect(early.dMin).toBeLessThanOrEqual(full.dMin);
    expect(early.visits).toBeLessThan(full.visits);
  });

  test("reports the worst tile", () => {
    const store = buildPyramid([...basin(AREA, 7), point(22.01, 60.005, 1.2)], OPTS);
    const r = query(store, [22.001, 60.001, 22.019, 60.009]);
    expect(r.worst?.z).toBe(18);
    expect(r.worst?.center[0]).toBeCloseTo(22.01, 3);
    expect(r.worst?.center[1]).toBeCloseTo(60.005, 3);
  });

  test("an empty chart stores nothing", () => {
    expect(buildPyramid([area(AREA, 3)], OPTS).count).toBe(0);
  });
});
