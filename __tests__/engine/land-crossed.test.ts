import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkRoute, LAND_CROSSED_FLAG } from "../../src/engine/route-check";
import type { LonLat } from "../../src/foundation/geo";
import type { ChartFeature } from "../../src/ingest/features";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import { edgeZoomFor } from "../../src/spatial/build-items";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { RuleIndex } from "../../src/spatial/rules";
import { CHART_DATUM } from "../helpers/engine";
import type { Box } from "../helpers/synthetic";
import { area, coverage, quality } from "../helpers/synthetic";

/**
 * The route check tells a leg whose own line crosses land (LAND_CROSSED, `land-line.ts`) from
 * one whose corridor reaches land (LAND): a planner lets a short leg from a berth carry the
 * second, never the first.
 */

const M_PER_DEG_LAT = 111195;
const BOX: Box = [22.0, 60.0, 22.012, 60.006];
const AT: [number, number] = [22.006, 60.003];
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((AT[1] * Math.PI) / 180);
const at = (x: number, y = 0): LonLat => [AT[0] + x / M_PER_DEG_LON, AT[1] + y / M_PER_DEG_LAT];
const NOW = Date.parse("2026-11-24T07:00:00Z");

const advisory = <F extends ChartFeature>(f: F): F => ({ ...f, advisory: true });

/** A basin west of AT, a breakwater 8 m wide from AT eastward, open water east of it. */
const index: ChartIndex = {
  catalogue: { version: 1, cells: [] },
  pyramid: buildPyramid(
    [
      advisory(coverage(BOX)),
      advisory(quality(BOX, 1)),
      advisory(area([BOX[0], BOX[1], AT[0], BOX[3]], 0)),
      advisory(area([at(8)[0], BOX[1], BOX[2], BOX[3]], 3))
    ],
    { minZoom: 12, leafZoom: 20, edgeZoom: edgeZoomFor(20) }
  ),
  hazards: new HazardIndex([]),
  rules: new RuleIndex([])
};

function flagsOf(from: LonLat, to: LonLat): { status: string; flags: string[] } {
  const input: RouteCheckInput = {
    coordinates: [from, to],
    departure: NOW,
    speeds: [2.5],
    xteLimit: 0,
    hullBuffer: 2,
    vessel: { draft: 0.9, length: 11, beam: 4 },
    dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => CHART_DATUM,
    probability: 0.01
  };
  const leg = checkRoute(index, input, NOW).legs[0];
  return { status: leg?.status ?? "", flags: leg?.flags ?? [] };
}

describe("a leg across a breakwater narrower than a leaf", () => {
  test("fails, flagged LAND and LAND_CROSSED: before, it read as water charted 0 m", () => {
    const leg = flagsOf(at(-40, -30), at(50, 20));
    expect(leg.status).toBe("fail");
    expect(leg.flags).toEqual(expect.arrayContaining(["LAND", LAND_CROSSED_FLAG]));
  });

  test("a leg along it, its corridor on the land, is flagged LAND alone", () => {
    const leg = flagsOf(at(-3, -40), at(-3, 40));
    expect(leg.status).toBe("fail");
    expect(leg.flags).toContain("LAND");
    expect(leg.flags).not.toContain(LAND_CROSSED_FLAG);
  });

  test("a leg from alongside it out into the basin is flagged LAND alone", () => {
    const leg = flagsOf(at(-1), at(-35, 10));
    expect(leg.flags).toContain("LAND");
    expect(leg.flags).not.toContain(LAND_CROSSED_FLAG);
  });

  test("a leg from alongside it through to the water behind is flagged LAND_CROSSED", () => {
    expect(flagsOf(at(-1), at(35, 10)).flags).toContain(LAND_CROSSED_FLAG);
    expect(flagsOf(at(35, 10), at(-1)).flags).toContain(LAND_CROSSED_FLAG);
  });

  test("a leg clear of it carries neither", () => {
    const leg = flagsOf(at(-60, -40), at(-20, 40));
    expect(leg.flags).not.toContain("LAND");
    expect(leg.flags).not.toContain(LAND_CROSSED_FLAG);
  });
});
