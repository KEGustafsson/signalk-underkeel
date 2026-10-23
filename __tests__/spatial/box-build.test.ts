import type { LonLat } from "../../src/foundation/geo";
import { groundToMercator, tileSize } from "../../src/foundation/geo";
import type { ChartFeature } from "../../src/ingest/features";
import { boxAround } from "../../src/ingest/wfs";
import { BOX_MARGIN_KM, boxRect } from "../../src/spatial/build-box";
import { BOX_REACH, DEFAULT_BUILD } from "../../src/spatial/build-items";
import { MAX_CHART_BUFFER } from "../../src/spatial/chart-position";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { sigmaFor } from "../../src/spatial/quality";
import type { Box } from "../helpers/synthetic";
import { area, basin, boxRing, coverage, point, quality } from "../helpers/synthetic";

/**
 * The index built in a box around the vessel (plan §4.2): tiles are built
 * out to the chart position reach past the box, so a hazard charted just
 * outside it still spreads its risk in (invariant 1), while no tile outside
 * the box reads as covered (invariants 3 and 4).
 */

const near = ([lon, lat]: LonLat, d = 0.0002) =>
  footprintGeom(boxRing([lon - d, lat - d, lon + d, lat + d]));

describe("tiles past the box", () => {
  // A band-2 basin around a 10 km box near the equator: the z10 root holding the box's east
  // edge spans lon 0 to 0.35°, some 39 km, so most of it lies far past the box.
  const centre: LonLat = [0.05, 0.05];
  const bbox = boxAround(centre, 10);
  const basinBand2 = basin([-1, -1, 1, 1], 20, { band: 2 }).map((f): ChartFeature => ({
    ...f,
    scale: 350_000
  }));
  const opts = { minZoom: 10, leafZoom: 16 };
  const boxed = buildPyramid(basinBand2, { ...opts, within: boxRect(bbox) });
  const whole = buildPyramid(basinBand2, opts);

  test("inside the box read as the whole build", () => {
    const read = (store: typeof boxed, lon: number) => {
      const { dMin, sigmaD, sigmaP, flags, coveredDMin } = minDepthOver(store, near([lon, 0.05]));
      return { dMin, sigmaD, sigmaP, flags, coveredDMin };
    };
    for (const lon of [0.05, 0.13]) {
      expect(read(boxed, lon)).toEqual(read(whole, lon));
      expect(read(boxed, lon).flags).toBe(0);
    }
  });

  test.each([0.15, 0.2, 0.25, 0.3])(
    "lon %f, past the box in a root it partly holds, is never covered (invariant 3)",
    (lon) => {
      expect(minDepthOver(whole, near([lon, 0.05])).flags).toBe(0);
      const r = minDepthOver(boxed, near([lon, 0.05]));
      expect(r.flags & FLAGS.NO_COVERAGE).not.toBe(0);
    }
  );

  test("beyond the chart position reach of the box no value is kept", () => {
    // 0.2° east is 16.7 km from the centre, 6.7 km past the box: far beyond BOX_REACH.
    for (const lon of [0.2, 0.25, 0.3]) {
      expect(minDepthOver(boxed, near([lon, 0.05])).dMin).toBe(-Infinity);
    }
  });

  test("a wreck in a cell the box does not read is not read as charted water", () => {
    const far = [
      ...basin([0.23, 0, 0.3, 0.1], 10, { band: 5, cellRef: 1 }),
      point(0.25, 0.05, 3, { objectClass: "WRECKS", band: 5, cellRef: 1 })
    ];
    expect(minDepthOver(whole, near([0.25, 0.05])).dMin).toBe(20);
    expect(minDepthOver(buildPyramid([...basinBand2, ...far], opts), near([0.25, 0.05])).dMin).toBe(
      3
    );
    const r = minDepthOver(boxed, near([0.25, 0.05]));
    expect(r.dMin).toBe(-Infinity);
    expect(r.flags & FLAGS.NO_COVERAGE).not.toBe(0);
  });
});

describe("a hazard just outside the box", () => {
  const M = 111195;
  const CHART: Box = [22.0, 60.0, 22.08, 60.04];
  const BOX: Box = [22.01, 60.0, 22.07, 60.02];
  const edge = BOX[3];
  const RISK = { threshold: 2, sigmaExtra: 0.3 };
  const opts = { minZoom: 12, leafZoom: 18 };
  const cell = (rockLat: number): ChartFeature[] => [
    coverage(CHART),
    quality(CHART, 4),
    area(CHART, 15),
    point(22.04, rockLat, 0.5)
  ];

  test.each([
    [30, 100],
    [30, 330],
    [100, 200]
  ])("%i m out raises P for a footprint %i m inside as the whole build does", (out, inside) => {
    const features = cell(edge + out / M);
    const whole = buildPyramid(features, opts);
    const boxed = buildPyramid(features, { ...opts, within: boxRect([...BOX]) });
    const at = footprintGeom([[22.04, edge - inside / M]]);
    const q = { bufferMetres: 15, chartPosition: true, risk: RISK };
    const a = minDepthOver(whole, at, q);
    const b = minDepthOver(boxed, at, q);
    expect(a.maxRisk).toBeGreaterThan(0.01);
    expect(b.maxRisk).toBeGreaterThanOrEqual(a.maxRisk);
    expect(b.riskTile?.dMin).toBe(0.5);
    // The rock lies outside the box, so its survey's reach also carries the box's edge in.
    expect(b.flags & FLAGS.NO_COVERAGE).not.toBe(0);
  });
});

test("the cells read reach every tile a box build gives a value", () => {
  // The build area's edge, a leaf across it at the coarsest leaf zoom (14) and the widest
  // burn radius (k · the unassessed σP).
  const leaf = tileSize(14) / groundToMercator(1, 0);
  const burn = DEFAULT_BUILD.k * sigmaFor(undefined, 0).sigmaP;
  expect(BOX_REACH).toBeGreaterThanOrEqual(MAX_CHART_BUFFER);
  expect(BOX_MARGIN_KM * 1000).toBeGreaterThanOrEqual(BOX_REACH + leaf + burn);
});
