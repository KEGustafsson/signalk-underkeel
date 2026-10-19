import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { Box } from "../helpers/synthetic";
import { basin, boxRing } from "../helpers/synthetic";

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
