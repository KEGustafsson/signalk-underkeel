import fc from "fast-check";
import { departureWindow } from "../../src/engine/departure-window";
import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkLeg, checkRoute } from "../../src/engine/route-check";
import { DEFAULT_REPAIR, repairLeg, repairRoute, simplify } from "../../src/engine/route-repair";
import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
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
