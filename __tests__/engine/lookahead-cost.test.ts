import type { NavState } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import type { VesselModel } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { fromMercator, tileAt, tileRect, toMercator } from "../../src/foundation/geo";
import { HazardIndex } from "../../src/spatial/hazards";
import { NodeStore } from "../../src/spatial/node-store";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { ctx } from "../helpers/engine";
import type { Box } from "../helpers/synthetic";
import { basin, land } from "../helpers/synthetic";

/**
 * The look-ahead's cost bounds (plan §4.8) change how much chart a tick
 * reads, never the state a footprint that decides it reports.
 */

const NOW = 1_800_000_000_000;
const KEEL: VesselModel = { draft: 1.9, length: 12, beam: 4 };
const EAST = Math.PI / 2;
const LAT = 60.005;
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180);
const CHART: Box = [22.0, 60.0, 22.04, 60.01];
/** A 30 m strip of land along the chart's east edge; past it there is no coverage. */
const STRIP: Box = [CHART[2] - 30 / M_PER_DEG_LON, 60.004, CHART[2], 60.006];

function indexOf(features: ReturnType<typeof basin>): ChartIndex {
  return {
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid(features, { minZoom: 12, leafZoom: 18 }),
    hazards: new HazardIndex([])
  };
}

function nav(lon: number, lat = LAT): NavState {
  const sog = 3;
  return {
    position: { value: [lon, lat], at: NOW },
    cog: { value: EAST, at: NOW },
    sog: { value: sog, at: NOW },
    heading: { value: EAST, at: NOW }
  };
}

/** Longitude `metres` west of the strip. */
const westOfStrip = (metres: number) => STRIP[0] - metres / M_PER_DEG_LON;

describe("certain land ends a footprint's chart walk", () => {
  test("land at the coverage edge under the vessel is an alarm", () => {
    const index = indexOf([...basin(CHART, 20), land(STRIP)]);
    const r = evaluateLookahead(nav(westOfStrip(-15)), ctx(KEEL), index, NOW);
    expect(r.state).toBe("alarm");
    expect(r.reason).toBe("shoal under the vessel");
    expect(r.footprints[0]?.risk).toBe(1);
  });

  /**
   * Four z16 tiles meet at a corner: water to the west, land to the north-east
   * and no chart to the south-east. A footprint on the corner walks the land
   * tile before the gap, so an early stop there would miss the gap.
   */
  const hazards = new HazardIndex([]);

  function corner(): { index: ChartIndex; at: (metres: number) => NavState } {
    const store = new NodeStore(16, 16);
    const [cx, cy] = toMercator(22.02, LAT);
    const { x, y } = tileAt(16, cx, cy);
    const water = { dMin: 20, sigmaD: 0.1, sigmaP: 1, flags: 0, cellRef: 0 };
    for (let dx = -3; dx <= 0; dx++) {
      for (const dy of [-1, 0, 1, 2]) {
        store.add(16, x + dx, y + dy, water, false, 0);
      }
    }
    store.add(16, x + 1, y, { ...water, dMin: -Infinity }, false, 0);
    const r = tileRect(16, x + 1, y);
    const [lon, lat] = fromMercator(r.minX, r.minY);
    const index = { catalogue: { version: 1 as const, cells: [] }, pyramid: store, hazards };
    const perDegree = 111320 * Math.cos((lat * Math.PI) / 180);
    const at = (metres: number) => nav(lon - metres / perDegree, lat);
    return { index, at };
  }

  test("past the warn window, land at a coverage gap still reports the gap", () => {
    const { index, at } = corner();
    // The horizon is 555.6 m / 3 m/s = 185 s; only footprints past 160 s reach the corner.
    const r = evaluateLookahead(at(555), ctx(KEEL), index, NOW);
    const reached = r.footprints.filter((f) => f.risk === 1);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((f) => f.t > DEFAULT_LOOKAHEAD.warnWithin && f.uncovered)).toBe(true);
    expect(r.state).toBe("warn");
    expect(r.reason).toMatch(/^no chart coverage ahead in \d+ s$/);
  });

  test("inside the warn window the land decides the state", () => {
    const { index, at } = corner();
    const r = evaluateLookahead(at(300), ctx(KEEL), index, NOW);
    expect(r.state).toBe("warn");
    expect(r.reason).toMatch(/^shoal ahead in \d+ s$/);
    expect(r.timeToShoal).toBeLessThanOrEqual(DEFAULT_LOOKAHEAD.warnWithin);
  });
});
