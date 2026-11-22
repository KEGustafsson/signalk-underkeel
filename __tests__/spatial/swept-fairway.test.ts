import { pilotBuffer } from "../../src/engine/pilotage";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { edgeZoomFor, pluginBuild } from "../../src/spatial/build-items";
import type { Box } from "../helpers/synthetic";
import { area, coverage, quality, swept } from "../helpers/synthetic";

/**
 * A fairway swept to its marks in a cell that charts it with its banks (the Traficom WFS with
 * the FTIA's fairway areas, `ingest/wfs-ftia.ts`): the depth area gives way to the dredged
 * areas covering a tile (`spatial/give-way.ts`), tiles across their edges split to the edge zoom,
 * and a query can tell whether its footprint lies in swept water all through (`sweptOnly`).
 */

const AREA: Box = [22.0, 60.0, 22.02, 60.01];
/** A channel about 22 m wide along 60.005° N, in two pieces meeting at 22.01° E. */
const WEST: Box = [22.0, 60.0049, 22.01, 60.0051];
const EAST: Box = [22.01, 60.0049, 22.02, 60.0051];

function chart() {
  return [
    coverage(AREA),
    quality(AREA, 1),
    // The 0–3 m depth area over the channel and its banks.
    area(AREA, 0),
    area(WEST, 2.7, { dredged: true }),
    area(EAST, 2.7, { dredged: true })
  ];
}

/** A footprint along the channel's line from lon a to lon b, with `buffer` metres about it. */
function along(store: ReturnType<typeof buildPyramid>, a: number, b: number, buffer: number) {
  const geom = footprintGeom([
    [a, 60.005],
    [b, 60.005]
  ]);
  return minDepthOver(store, geom, { bufferMetres: buffer, sweptOnly: true });
}

describe("a swept fairway charted with its banks", () => {
  const store = buildPyramid(chart(), { minZoom: 12, ...pluginBuild(20) });

  test("the depth area gives way inside the channel, the seam between its pieces too", () => {
    const west = along(store, 22.004, 22.006, 3);
    expect(west.dMin).toBe(2.7);
    expect(west.flags & FLAGS.DREDGED).toBe(FLAGS.DREDGED);
    // Across the seam at 22.01° E neither piece holds the tile alone.
    const seam = along(store, 22.0099, 22.0101, 3);
    expect(seam.dMin).toBe(2.7);
    expect(seam.unswept).toBe(false);
  });

  test("a footprint within the channel is swept all through; one reaching the banks is not", () => {
    expect(along(store, 22.004, 22.016, 3).unswept).toBe(false);
    const wide = along(store, 22.004, 22.016, 15);
    expect(wide.unswept).toBe(true);
    expect(wide.dMin).toBe(0);
  });

  test("tiles across the channel's edges split to the edge zoom, finer than the leaf zoom", () => {
    expect(store.leafZoom).toBe(edgeZoomFor(20));
    // At the leaf zoom alone a 19 m tile across the edge keeps the bank's 0 m.
    const coarse = buildPyramid(chart(), { minZoom: 12, leafZoom: 20 });
    expect(along(coarse, 22.004, 22.006, 3).dMin).toBe(0);
    expect(along(store, 22.004, 22.006, 3).dMin).toBe(2.7);
  });

  test("open water reads unswept, and a query not asking says nothing of it", () => {
    const open = buildPyramid([coverage(AREA), quality(AREA, 1), area(AREA, 8)], pluginBuild(20));
    const geom = footprintGeom([[22.005, 60.005]]);
    expect(minDepthOver(open, geom, { bufferMetres: 3, sweptOnly: true }).unswept).toBe(true);
    expect(minDepthOver(open, geom, { bufferMetres: 3 }).unswept).toBeUndefined();
  });
});

describe("sweeps side by side", () => {
  test("two swept areas meeting along a seam guarantee their depth across it", () => {
    const west = { ...swept(WEST, 2.7), objectClass: "SWPARE" };
    const east = swept(EAST, 2.1);
    const features = [...chart(), west, east];
    const store = buildPyramid(features, { minZoom: 12, ...pluginBuild(20) });
    const seam = along(store, 22.0099, 22.0101, 3);
    expect(seam.dMin).toBe(2.1);
    expect(seam.flags & FLAGS.SWEPT).toBe(FLAGS.SWEPT);
    // The guarantee decides the depth's σ: the swept σ, not the survey's.
    const open = buildPyramid(chart(), { minZoom: 12, ...pluginBuild(20) });
    expect(seam.sigmaD).toBeLessThan(along(open, 22.0099, 22.0101, 3).sigmaD);
  });
});

describe("the pilotage buffer", () => {
  const fix = (sigmaPos: number, ok = true) => ({ sigmaPos, ok, reasons: [], divergence: null });

  test("kp times the fix's σ, at least 2 m, while narrower than the least buffer", () => {
    expect(pilotBuffer(fix(1.5), 2, 10)).toBe(3);
    expect(pilotBuffer(fix(0.3), 2, 10)).toBe(2);
    expect(pilotBuffer(fix(6), 2, 10)).toBeUndefined();
  });

  test("none without a good, measured fix", () => {
    expect(pilotBuffer(fix(1.5, false), 2, 10)).toBeUndefined();
    expect(pilotBuffer(undefined, 2, 10)).toBeUndefined();
    expect(pilotBuffer(fix(Number.NaN), 2, 10)).toBeUndefined();
  });
});
