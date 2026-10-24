import fc from "fast-check";
import { departureWindow } from "../../src/engine/departure-window";
import type { LegResult, RouteCheckInput } from "../../src/engine/route-check";
import { checkLeg, checkRoute, legCorridors } from "../../src/engine/route-check";
import type { LegRepair } from "../../src/engine/route-repair";
import { DEFAULT_REPAIR, repairLeg, repairRoute, simplify } from "../../src/engine/route-repair";
import { QUERY_WORK } from "../../src/engine/work";
import type { LonLat } from "../../src/foundation/geo";
import { haversine, toMercator } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import type { WaterLevel } from "../../src/model/uncertainty";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import * as pyramid from "../../src/spatial/pyramid";
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

/** The 10 m basin with one more feature. */
function shoalIndexWith(feature: ReturnType<typeof area>): ChartIndex {
  return {
    ...shoalIndex(),
    pyramid: buildPyramid([...basin([22.0, 60.0, 22.06, 60.03], 10), feature], {
      minZoom: 12,
      leafZoom: 18
    })
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
    const {
      repairs: [repair, ...rest]
    } = await repairRoute(index, input(LEG));
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

  test("one leg's search lets other work in between slices of a few hundred cells", async () => {
    // A long leg whose shoal fills most of the grid's width, so the search expands many cells.
    const wall = shoalIndexWith(area([22.02, 60.004, 22.04, 60.026], 1));
    const queries = jest.spyOn(pyramid, "minDepthOver");
    const slices: number[] = [];
    let last = 0;
    const pause = () => {
      slices.push(queries.mock.calls.length - last);
      last = queries.mock.calls.length;
      return Promise.resolve();
    };
    const leg = input([
      [22.005, 60.015],
      [22.055, 60.015]
    ]);
    const { repairs } = await repairRoute(wall, leg, DEFAULT_REPAIR, pause);
    queries.mockRestore();
    const checked = checkRoute(wall, leg, NOW).legs[0] as LegResult;
    expect(repairs).toEqual([repairLeg(wall, leg, checked)]);
    const total = slices.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(1000);
    // 256 expansions of up to 8 neighbours each, and the cells along their lines of sight.
    expect(Math.max(...slices)).toBeLessThan(total / 3);
  });

  test("legs that pass are left alone", async () => {
    const clear: LonLat[] = [
      [22.01, 60.005],
      [22.05, 60.005]
    ];
    const checked = checkRoute(index, input(clear), NOW);
    const { repairs, route } = await repairRoute(index, input(clear));
    expect(repairs).toEqual([]);
    expect(route.coordinates).toEqual(clear);
    expect(route.legs).toEqual(checked.legs);
  });

  test("legs past the per-request limit are listed with a reason, not searched", async () => {
    // The same failing leg there and back three times: six failing legs.
    const zigzag: LonLat[] = [LEG[0], LEG[1], LEG[0], LEG[1], LEG[0], LEG[1], LEG[0]] as LonLat[];
    let pauses = 0;
    const { repairs } = await repairRoute(
      index,
      input(zigzag),
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
    // After each searched leg, and after each corridor query of the repaired route's re-check.
    expect(pauses).toBeGreaterThan(2);
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

  test("a shoal near a long leg's waypoint, outside its corridor, does not block the search", async () => {
    // A 30 km leg searches 500 m cells. A rock 200 m north of the start lies inside the start
    // cell's disc (its centre 250 m east and north, radius 30 m + 250 m), not in the corridor.
    const long: LonLat[] = [
      [22.0, 60.0],
      [22.54, 60.0]
    ];
    const rocky: ChartIndex = {
      ...index,
      pyramid: buildPyramid(
        [
          ...basin([21.6, 59.8, 22.9, 60.2], 10),
          area([22.27, 59.97, 22.272, 60.03], 1),
          area([21.9998, 60.0017, 22.0002, 60.0019], 1)
        ],
        { minZoom: 10, leafZoom: 18 }
      )
    };
    const checked = checkRoute(rocky, input(long), NOW).legs[0] as LegResult;
    expect(checked.status).toBe("fail");
    const repair = repairLeg(rocky, input(long), checked);
    expect(repair.reason).toBeUndefined();
    expect(repair.waypoints.length).toBeGreaterThan(0);
    expect(repair.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("a rock just past a long leg's end, inside the end's cell, is passed", () => {
    // The 30 km leg's ends lie on corners of their 500 m cells; a 1 m rock 200 m along the leg
    // from either end lies in that end's cell, on the leg. Lines out of the start cell and into
    // the goal cell must be checked from the end itself, or the path's first or last line runs
    // over the rock and the repair is lost.
    const long: LonLat[] = [
      [22.0, 60.0],
      [22.54, 60.0]
    ];
    for (const lon of [22.0 + 200 / 55597, 22.54 - 200 / 55597]) {
      const rocky: ChartIndex = {
        ...index,
        pyramid: buildPyramid(
          [
            ...basin([21.6, 59.8, 22.9, 60.2], 10),
            area([lon - 2e-4, 59.9999, lon + 2e-4, 60.0001], 1)
          ],
          { minZoom: 10, leafZoom: 18 }
        )
      };
      const checked = checkRoute(rocky, input(long), NOW).legs[0] as LegResult;
      expect(checked.status).toBe("fail");
      const repair = repairLeg(rocky, input(long), checked);
      expect(repair.reason).toBeUndefined();
      expect(repair.waypoints.length).toBeGreaterThan(0);
      expect(repair.legs.every((l) => l.status === "ok")).toBe(true);
    }
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
    const {
      repairs: [repair]
    } = await repairRoute(b, input(LEG));
    expect(repair?.reason).toBeUndefined();
    expect(repair?.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("a repair that delays the later legs re-checks them at their new times", async () => {
    // A drying shoal across leg 0, and a bank on leg 1 passable only until the water falls,
    // 20 s after the original arrival at its end: the detour round the shoal makes leg 1 late.
    const tidal: ChartIndex = {
      ...index,
      pyramid: buildPyramid(
        [
          ...basin([22.0, 60.0, 22.07, 60.04], 10),
          area([22.027, 60.012, 22.033, 60.018], -1),
          area([22.045, 60.019, 22.055, 60.021], 1.5)
        ],
        { minZoom: 12, leafZoom: 18 }
      )
    };
    const route: LonLat[] = [LEG[0] as LonLat, LEG[1] as LonLat, [22.05, 60.025]];
    const onTime = checkRoute(tidal, input(route), NOW).legs;
    const drop = Date.parse(onTime[1]?.eta.end as string) + 20_000;
    const falling = input(route, {
      waterLevel: (_s, e) => ({ h: e < drop ? 1.5 : 0, sigma: 0.05, source: "manual" })
    });
    expect(checkRoute(tidal, falling, NOW).legs.map((l) => l.status)).toEqual(["fail", "ok"]);
    const { repairs, route: repaired } = await repairRoute(tidal, falling);
    expect(repairs[0]?.waypoints.length).toBeGreaterThan(0);
    // Leg 1, sailed later, is looked at again rather than reported as it was.
    expect(repairs.map((r) => r.index)).toContain(1);
    const recheck = checkRoute(
      tidal,
      {
        ...falling,
        coordinates: repaired.coordinates,
        speeds: repaired.coordinates.slice(1).map(() => 3)
      },
      NOW
    );
    expect(repaired.legs.map((l) => l.status)).toEqual(recheck.legs.map((l) => l.status));
    expect(repaired.legs.map((l) => l.eta)).toEqual(recheck.legs.map((l) => l.eta));
  });

  test("the search plans at the water level the detour is sailed in, not the leg's", () => {
    // A drying shoal reaching further south than north, so the way round to the north is the
    // shorter. North of the leg's last part, a bank passable only until the water falls, 20 s
    // after the straight leg would arrive: the northern detour reaches it after that.
    const tidal: ChartIndex = {
      ...index,
      pyramid: buildPyramid(
        [
          ...basin([22.0, 60.0, 22.06, 60.03], 10),
          area([22.027, 60.008, 22.033, 60.02], -1),
          area([22.033, 60.0175, 22.05, 60.025], 1.5)
        ],
        { minZoom: 12, leafZoom: 18 }
      )
    };
    const leg = checkRoute(tidal, input(LEG), NOW).legs[0] as LegResult;
    const drop = Date.parse(leg.eta.end) + 20_000;
    const falling = input(LEG, {
      waterLevel: (_s, e) => ({ h: e < drop ? 1.5 : 0, sigma: 0.05, source: "manual" })
    });
    expect(checkRoute(tidal, falling, NOW).legs[0]?.status).toBe("fail");
    const repair = repairLeg(tidal, falling, leg);
    expect(repair.reason).toBeUndefined();
    expect(repair.legs.every((l) => l.status === "ok")).toBe(true);
    // Round the south, clear of the bank the boat would reach after the water falls.
    expect(repair.waypoints.length).toBeGreaterThan(0);
    for (const [, lat] of repair.waypoints) {
      expect(lat).toBeLessThan(60.015);
    }
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

  test("each chord is checked at the time the simplified path reaches its start", () => {
    // A zigzag no chord over more than two spans passes, so every point but one stays.
    const pts: LonLat[] = [
      [22.0, 60.0],
      [22.01, 60.004],
      [22.02, 60.0],
      [22.03, 60.004],
      [22.04, 60.0],
      [22.05, 60.004]
    ];
    const speed = 3;
    const calls: { from: LonLat; departure: number }[] = [];
    const passes = (q: LonLat[], departure: number): boolean => {
      calls.push({ from: q[0] as LonLat, departure });
      return pts.indexOf(q[1] as LonLat) - pts.indexOf(q[0] as LonLat) <= 2;
    };
    const kept = simplify(pts, passes, NOW, speed);
    expect(kept.length).toBeLessThan(pts.length);
    // Each chord departs when the route check of the kept path starts that leg.
    const legs = checkRoute(
      shoalIndex(),
      input(kept, { speeds: kept.slice(1).map(() => speed) }),
      NOW
    ).legs;
    const eta = new Map<LonLat, number>(
      legs.map((leg, i) => [kept[i] as LonLat, Date.parse(leg.eta.start)])
    );
    expect(calls.some((c) => c.departure > NOW)).toBe(true);
    for (const c of calls) {
      expect(c.departure).toBe(eta.get(c.from));
    }
  });
});

interface Query {
  geom: Geom;
  bufferMetres?: number;
  visits: number;
}

/**
 * Records every minDepthOver call until `restore`; `extraVisits` adds to a
 * polygon query's reported visits, to make checks cost more work.
 */
function spyQueries(extraVisits = 0): { calls: Query[]; restore: () => void } {
  const calls: Query[] = [];
  const real = pyramid.minDepthOver;
  const spy = jest.spyOn(pyramid, "minDepthOver").mockImplementation((p, geom, opts) => {
    const r = real(p, geom, opts);
    const visits = r.visits + (geom.type === "polygon" ? extraVisits : 0);
    calls.push({ geom, bufferMetres: opts?.bufferMetres, visits });
    return { ...r, visits };
  });
  return { calls, restore: () => spy.mockRestore() };
}

const SEARCH_LIMIT =
  /^the repair search reached the work limit for one leg; add a waypoint near \[-?\d+\.\d{5}, -?\d+\.\d{5}\] \(lon, lat\) to split the leg, or use a smaller xteLimit$/;
const CHECK_LIMIT =
  /^the path found could not be checked within the work limit for one leg; add a waypoint near \[/;
const REQUEST_LIMIT =
  "not searched: this request has used its repair work limit; repair this leg in another request";

/** A repair either passes whole or is refused for its work limit, with no waypoints. */
function expectPassedOrLimited(repair: LegRepair | undefined): void {
  if (repair?.reason === undefined) {
    expect(repair?.waypoints.length).toBeGreaterThan(0);
    expect(repair?.legs.every((l) => l.status === "ok")).toBe(true);
  } else {
    expect(repair).toMatchObject({ waypoints: [], legs: [] });
    expect(SEARCH_LIMIT.test(repair.reason) || CHECK_LIMIT.test(repair.reason)).toBe(true);
  }
}

describe("repair work limits", () => {
  const shoal = shoalIndex();
  // The shoal fills most of the grid's width, so the search expands many cells.
  const wall = shoalIndexWith(area([22.02, 60.004, 22.04, 60.026], 1));
  const wallLeg = input([
    [22.005, 60.015],
    [22.055, 60.015]
  ]);
  const wallChecked = checkRoute(wall, wallLeg, NOW).legs[0] as LegResult;

  test("a search that needs more than its share of the work is refused with the leg's worst position", async () => {
    const opts = { ...DEFAULT_REPAIR, maxWork: 20_000 };
    const spy = spyQueries();
    const repair = repairLeg(wall, wallLeg, wallChecked, opts);
    spy.restore();
    expect(repair.reason).toMatch(SEARCH_LIMIT);
    expect(repair).toMatchObject({ waypoints: [], legs: [] });
    // No cell is scored once the search has done its share.
    const scored = spy.calls.filter((q) => q.geom.type === "point").map((q) => q.visits);
    const before = scored.slice(0, -1).reduce((sum, v) => sum + v + QUERY_WORK, 0);
    expect(before).toBeLessThan(0.8 * 20_000);
    // The leg keeps its own status: unrepaired is never safe (invariants 3 and 4).
    const { repairs, route } = await repairRoute(wall, wallLeg, opts);
    expect(repairs).toEqual([repair]);
    expect(route.legs[0]?.status).toBe("fail");
  });

  test("a final check that cannot finish within the limit is refused, not returned", () => {
    // Each corridor query reports 50 000 more tiles, so the search fits in budgets where the
    // checks after it do not.
    const spy = spyQueries(50_000);
    const reasons: (string | undefined)[] = [];
    for (const maxWork of [150_000, 300_000, 450_000, 600_000, 1_200_000, Infinity]) {
      const repair = repairLeg(wall, wallLeg, wallChecked, {
        ...DEFAULT_REPAIR,
        maxWork,
        searchShare: 1,
        simplifyShare: 1
      });
      expectPassedOrLimited(repair);
      reasons.push(repair.reason);
    }
    spy.restore();
    expect(reasons.some((r) => r !== undefined && CHECK_LIMIT.test(r))).toBe(true);
    expect(reasons.at(-1)).toBeUndefined();
  });

  test("the request's work limit leaves later legs unsearched, with a reason", async () => {
    const zigzag = [LEG[0], LEG[1], LEG[0], LEG[1]] as LonLat[];
    const { repairs, route } = await repairRoute(shoal, input(zigzag), {
      ...DEFAULT_REPAIR,
      maxRequestWork: 1
    });
    expect(repairs.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(repairs[0]?.reason).toBeUndefined();
    expect(repairs[0]?.waypoints.length).toBeGreaterThan(0);
    for (const r of repairs.slice(1)) {
      expect(r).toEqual({ index: r.index, waypoints: [], legs: [], reason: REQUEST_LIMIT });
    }
    // The unsearched legs stay as they were checked, never ok (invariant 4).
    const unrepaired = route.legs.slice(-2);
    expect(unrepaired.map((l) => [l.from, l.to])).toEqual([
      [LEG[1], LEG[0]],
      [LEG[0], LEG[1]]
    ]);
    for (const l of unrepaired) {
      expect(["fail", "marginal"]).toContain(l.status);
    }
  });

  test("a leg's repair is the same alone and inside a request, and the default limits change nothing here", async () => {
    const unlimited = { ...DEFAULT_REPAIR, maxWork: Infinity, maxRequestWork: Infinity };
    const box = [22.0, 60.0, 22.06, 60.03] as const;
    const catzocB: ChartIndex = {
      ...shoal,
      pyramid: buildPyramid(
        [coverage(box), quality(box, 3), area(box, 10), area([22.027, 60.012, 22.033, 60.018], 1)],
        { minZoom: 12, leafZoom: 18 }
      )
    };
    const zigzag = [LEG[0], LEG[1], LEG[0]] as LonLat[];
    for (const [chart, route] of [
      [shoal, input(zigzag)],
      [wall, wallLeg],
      [catzocB, input(LEG)]
    ] as const) {
      const limited = await repairRoute(chart, route, DEFAULT_REPAIR);
      expect(limited.repairs.length).toBeGreaterThan(0);
      expect(limited.repairs.every((r) => r.reason === undefined)).toBe(true);
      expect(await repairRoute(chart, route, unlimited)).toEqual(limited);
      const first = checkRoute(chart, route, NOW).legs[0] as LegResult;
      expect(repairLeg(chart, route, first)).toEqual(limited.repairs[0]);
    }
  });

  test("repair results do not depend on timing", async () => {
    let seed = 7;
    const jitter = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return new Promise<void>((resolve) => setTimeout(resolve, seed % 4));
    };
    const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));
    for (const opts of [DEFAULT_REPAIR, { ...DEFAULT_REPAIR, maxWork: 20_000 }]) {
      const a = await repairRoute(wall, wallLeg, opts, immediate);
      const b = await repairRoute(wall, wallLeg, opts, jitter);
      expect(b).toEqual(a);
    }
  });

  test("a wide corridor's cells are at least half its width", () => {
    // Corridor half-width 400 m: cells of 200 m or more, each scored 400 m plus half a cell out.
    const wide = input(LEG, { xteLimit: 390, planningBuffer: 10 });
    const leg = checkRoute(shoal, wide, NOW).legs[0] as LegResult;
    expect(leg.status).toBe("fail");
    const spy = spyQueries();
    repairLeg(shoal, wide, leg);
    spy.restore();
    const ends = LEG.map(([lon, lat]) => toMercator(lon, lat));
    const cells = spy.calls.filter(
      (q) =>
        q.geom.type === "point" &&
        !ends.some(([x, y]) => q.geom.type === "point" && q.geom.p[0] === x && q.geom.p[1] === y)
    );
    expect(cells.length).toBeGreaterThan(0);
    for (const q of cells) {
      expect(q.bufferMetres).toBeGreaterThanOrEqual(400 + 100);
    }
  });

  test("simplification never re-checks the leg's own chord", () => {
    const spy = spyQueries();
    repairLeg(wall, wallLeg, wallChecked);
    spy.restore();
    const [from, to] = wallLeg.coordinates as [LonLat, LonLat];
    const own = legCorridors(from, to, 30).map((ring) => footprintGeom(ring));
    const rings = spy.calls.flatMap((q) => (q.geom.type === "polygon" ? [q.geom] : []));
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of own) {
      expect(rings).not.toContainEqual(ring);
    }
  });

  test("whatever the limit, a repair passes or gives a reason", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400_000 }), (maxWork) => {
        expectPassedOrLimited(
          repairLeg(wall, wallLeg, wallChecked, { ...DEFAULT_REPAIR, maxWork })
        );
      }),
      { numRuns: 15 }
    );
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

  test("a low water between two sampled departures is not a window", async () => {
    // High water at 0, 12 and 24 h, low water at 6 and 18 h; sampled every 12 h.
    const h = (t: number) => 0.5 + Math.cos(((t - NOW) / (12 * HOUR)) * 2 * Math.PI);
    const lowest = (s: number, e: number): WaterLevel => {
      let m = Math.min(h(s), h(e));
      for (let t = s; t <= e; t += 60_000) {
        m = Math.min(m, h(t));
      }
      return { h: m, sigma: 0.05, source: "manual" };
    };
    const route = input(LEG, { vessel: shallow, waterLevel: lowest });
    const at6 = checkRoute(index, { ...route, departure: NOW + 6 * HOUR }, NOW).legs[0];
    expect(at6?.status).toBe("fail");
    const w = await departureWindow(index, route, NOW, NOW + 24 * HOUR, 12 * HOUR);
    expect(w.windows).toEqual([]);
  });

  test("legs are re-checked only when their water level changes", async () => {
    const route = input(LEG, { vessel: shallow, waterLevel: (s) => tide(s) });
    const w = await departureWindow(index, route, NOW, NOW + 12 * HOUR, 15 * 60_000);
    expect(w.checks).toBeLessThanOrEqual(3);
  });

  test("a departure checks no leg after its first failing one, and its status is unchanged", async () => {
    // The shoal leg first, then three legs in open water; the level falls 1 cm per departure.
    const route: LonLat[] = [...LEG, [22.05, 60.025], [22.01, 60.025], [22.01, 60.005]];
    const falling = (s: number): WaterLevel => ({
      h: -0.5 - Math.floor((s - NOW) / (15 * 60_000)) / 100,
      sigma: 0.05,
      source: "manual"
    });
    const r = input(route, { waterLevel: falling });
    const w = await departureWindow(index, r, NOW, NOW + 4 * HOUR, 15 * 60_000);
    expect(w.steps.map((s) => s.status)).toEqual(
      directStatuses(index, r, NOW, NOW + 4 * HOUR, 15 * 60_000)
    );
    expect(w.steps.every((s) => s.status === "fail")).toBe(true);
    expect(w.checks).toBeLessThanOrEqual(w.steps.length);
  });

  test("reusing a leg's result at another water level never differs from checking it directly", async () => {
    const route: LonLat[] = [...LEG, [22.03, 60.025], [22.03, 60.005]];
    const step = 15 * 60_000;
    await fc.assert(
      fc.asyncProperty(
        // Levels a few centimetres apart, so legs change status between departures.
        fc.integer({ min: -80, max: 200 }),
        fc.array(fc.integer({ min: -12, max: 12 }), { minLength: 9, maxLength: 9 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 20, max: 250 }),
        async (base, offsets, sigmaCm, pExp, draftCm) => {
          const level = (s: number): WaterLevel => ({
            h: (base + (offsets[Math.min(8, Math.floor((s - NOW) / step))] as number)) / 100,
            sigma: sigmaCm / 100,
            source: "manual"
          });
          const r = input(route, {
            vessel: { draft: draftCm / 100, length: 6, beam: 2 },
            waterLevel: level,
            // 1e-3..0.5: the range in which results are reused across levels.
            probability: 10 ** (-3 + (2.7 * pExp) / 1000)
          });
          const w = await departureWindow(index, r, NOW, NOW + 8 * step, step);
          expect(w.steps.map((s) => s.status)).toEqual(
            directStatuses(index, r, NOW, NOW + 8 * step, step)
          );
        }
      ),
      { numRuns: 60 }
    );
  });

  test("a leg ok at one level is ok at a higher one without a new check", async () => {
    const step = 15 * 60_000;
    // Rising 10 cm per departure from well above the shoal's depth.
    const rising = (s: number): WaterLevel => ({
      h: 1.5 + Math.floor((s - NOW) / step) / 10,
      sigma: 0.05,
      source: "manual"
    });
    const r = input(LEG, { vessel: shallow, waterLevel: rising });
    const w = await departureWindow(index, r, NOW, NOW + 8 * step, step);
    expect(w.steps.every((s) => s.status === "ok")).toBe(true);
    expect(w.checks).toBe(1);
    // Below 1e-3 every level is checked directly.
    const strict = await departureWindow(
      index,
      { ...r, probability: 1e-4 },
      NOW,
      NOW + 8 * step,
      step
    );
    expect(strict.checks).toBe(9);
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

const RANK = { ok: 0, marginal: 1, unverified: 2, fail: 3 } as const;

/** Each departure's worst leg status, every leg checked at its own level, rounded as the window rounds it. */
function directStatuses(
  index: ChartIndex,
  route: RouteCheckInput,
  from: number,
  to: number,
  stepMs: number
): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t += stepMs) {
    let start = t;
    let worst: keyof typeof RANK = "ok";
    for (let i = 0; i + 1 < route.coordinates.length; i++) {
      const a = route.coordinates[i] as LonLat;
      const b = route.coordinates[i + 1] as LonLat;
      const end = start + (haversine(a, b) / (route.speeds[i] as number)) * 1000;
      const wl = route.waterLevel(start, end + stepMs, [a, b]);
      const level = {
        ...wl,
        h: Math.floor(wl.h * 100) / 100,
        sigma: Math.ceil(wl.sigma * 100) / 100
      };
      const status = checkLeg(index, { ...route, waterLevel: () => level }, i, start).leg.status;
      worst = RANK[status] > RANK[worst] ? status : worst;
      start = end;
    }
    out.push(worst);
  }
  return out;
}
