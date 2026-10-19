import { departureWindow } from "../../src/engine/departure-window";
import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkRoute } from "../../src/engine/route-check";
import { DEFAULT_REPAIR, repairLeg, repairRoute, simplify } from "../../src/engine/route-repair";
import type { LonLat } from "../../src/foundation/geo";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import type { WaterLevel } from "../../src/model/uncertainty";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { area, basin, coverage, quality } from "../helpers/synthetic";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3600_000;
const LEVEL: WaterLevel = { h: 0, sigma: 0.1, source: "manual" };

/** A 10 m basin with a 1 m shoal box across the middle of an east–west leg. */
function shoalIndex(): ChartIndex {
  return {
    catalogue: { version: 1, cells: [{ name: "T", edition: 1, update: 0, band: 5 }] },
    pyramid: buildPyramid(
      [...basin([22.0, 60.0, 22.06, 60.03], 10), area([22.027, 60.012, 22.033, 60.018], 1)],
      { minZoom: 12, leafZoom: 18 }
    ),
    hazards: new HazardIndex([])
  };
}

const LEG: LonLat[] = [
  [22.01, 60.015],
  [22.05, 60.015]
];

function input(coordinates: LonLat[], extra: Partial<RouteCheckInput> = {}): RouteCheckInput {
  return {
    coordinates,
    departure: NOW,
    speeds: coordinates.slice(1).map(() => 3),
    xteLimit: 20,
    planningBuffer: 10,
    vessel: { draft: 1.8, length: 12, beam: 4 },
    dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => LEVEL,
    probability: 0.01,
    ...extra
  };
}

describe("route repair", () => {
  const index = shoalIndex();

  test("a leg through the shoal gets waypoints around it, and the new legs pass", async () => {
    const checked = checkRoute(index, input(LEG), NOW);
    expect(checked.legs[0]?.status).toBe("fail");
    const [repair, ...rest] = await repairRoute(index, input(LEG), checked.legs);
    expect(rest).toEqual([]);
    expect(repair?.reason).toBeUndefined();
    expect(repair?.waypoints.length).toBeGreaterThanOrEqual(1);
    expect(repair?.legs.every((l) => l.status === "ok")).toBe(true);
    // The new legs keep clear of the shoal box.
    for (const p of repair?.waypoints ?? []) {
      expect(minDepthOver(index.pyramid, footprintGeom([p]), { bufferMetres: 30 }).dMin).toBe(10);
    }
    // Existing points are not moved: the repair starts and ends on the leg's own ends.
    expect(repair?.legs[0]?.from).toEqual(LEG[0]);
    expect(repair?.legs.at(-1)?.to).toEqual(LEG[1]);
  });

  test("legs that pass are left alone", async () => {
    const clear: LonLat[] = [
      [22.01, 60.005],
      [22.05, 60.005]
    ];
    const checked = checkRoute(index, input(clear), NOW);
    expect(await repairRoute(index, input(clear), checked.legs)).toEqual([]);
  });

  test("legs past the per-request limit are listed with a reason, not searched", async () => {
    // The same failing leg there and back three times: six failing legs.
    const zigzag: LonLat[] = [LEG[0], LEG[1], LEG[0], LEG[1], LEG[0], LEG[1], LEG[0]] as LonLat[];
    const checked = checkRoute(index, input(zigzag), NOW);
    let pauses = 0;
    const repairs = await repairRoute(
      index,
      input(zigzag),
      checked.legs,
      { ...DEFAULT_REPAIR, maxLegs: 2 },
      () => {
        pauses += 1;
        return Promise.resolve();
      }
    );
    expect(repairs.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(repairs.slice(0, 2).every((r) => r.waypoints.length > 0)).toBe(true);
    for (const r of repairs.slice(2)) {
      expect(r).toMatchObject({ waypoints: [], legs: [] });
      expect(r.reason).toBe("not searched: at most 2 legs are repaired per request");
    }
    expect(pauses).toBe(2);
  });

  test("a shoal that closes the whole search window is reported, not routed through", () => {
    const wall: ChartIndex = {
      ...index,
      pyramid: buildPyramid(
        [...basin([22.0, 59.9, 22.06, 60.1], 10), area([22.028, 59.9, 22.032, 60.1], 1)],
        { minZoom: 12, leafZoom: 18 }
      )
    };
    const checked = checkRoute(wall, input(LEG), NOW);
    const repair = repairLeg(wall, input(LEG), checked.legs[0] as never);
    expect(repair.waypoints).toEqual([]);
    expect(repair.reason).toBe("no passable path in the search window");
  });

  test("the search keeps the chart's position uncertainty clear of the shoal", async () => {
    // CATZOC B: depth areas may lie 50 m from where they are drawn.
    const box = [22.0, 60.0, 22.06, 60.03] as const;
    const b: ChartIndex = {
      ...index,
      pyramid: buildPyramid(
        [coverage(box), quality(box, 3), area(box, 10), area([22.027, 60.012, 22.033, 60.018], 1)],
        { minZoom: 12, leafZoom: 18 }
      )
    };
    const checked = checkRoute(b, input(LEG), NOW);
    const [repair] = await repairRoute(b, input(LEG), checked.legs);
    expect(repair?.reason).toBeUndefined();
    expect(repair?.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("simplification keeps a point only where the chord would fail", () => {
    const pts: LonLat[] = [
      [0, 0],
      [1, 0.001],
      [2, 1],
      [3, 0]
    ];
    expect(simplify(pts, () => true)).toEqual([pts[0], pts[3]]);
    // The chord 0–3 and 0–2 fail; 2–3 passes: point 2 stays.
    const fails = (q: LonLat[]) => !(q[0] === pts[0] && (q[1] === pts[3] || q[1] === pts[2]));
    expect(simplify(pts, fails)).toEqual([pts[0], pts[1], pts[2], pts[3]]);
  });
});

describe("departure window", () => {
  const index = shoalIndex();
  // Over the shoal at 1 m charted: a 0.3 m draft passes only when the water is high.
  const shallow = { draft: 0.3, length: 6, beam: 2 };
  // Water above chart datum: 1.5 m in the first 6 hours, 0 m after.
  const tide = (start: number): WaterLevel => ({
    h: start < NOW + 6 * HOUR ? 1.5 : 0,
    sigma: 0.05,
    source: "manual"
  });

  test("windows are the departures in which every leg passes", async () => {
    const route = input(LEG, { vessel: shallow, waterLevel: (s) => tide(s) });
    const w = await departureWindow(index, route, NOW, NOW + 12 * HOUR, 15 * 60_000);
    expect(w.steps).toHaveLength(49);
    expect(w.windows).toHaveLength(1);
    expect(Date.parse(w.windows[0]?.from as string)).toBe(NOW);
    // The last ok departure arrives before the level drops at +6 h.
    expect(Date.parse(w.windows[0]?.to as string)).toBeLessThan(NOW + 6 * HOUR);
    expect(w.steps.at(-1)?.status).not.toBe("ok");
  });

  test("legs are re-checked only when their water level changes", async () => {
    const route = input(LEG, { vessel: shallow, waterLevel: (s) => tide(s) });
    const w = await departureWindow(index, route, NOW, NOW + 12 * HOUR, 15 * 60_000);
    expect(w.checks).toBeLessThanOrEqual(3);
  });

  test("a fallback water level is never a window", async () => {
    const fallback = {
      h: 0,
      sigma: 0.3,
      source: "fallback",
      degraded: "water level from fmi is 40 min old"
    };
    const route = input(LEG, { vessel: shallow, waterLevel: () => fallback });
    expect((await departureWindow(index, route, NOW, NOW + HOUR, 15 * 60_000)).windows).toEqual([]);
  });
});
