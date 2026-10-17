import fc from "fast-check";
import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkRoute, corridorRing } from "../../src/engine/route-check";
import { flagNames } from "../../src/spatial/node-store";
import { haversine, project, toMercator } from "../../src/foundation/geo";
import type { LonLat } from "../../src/foundation/geo";
import { pointInPolygon, pointSegmentDistance } from "../../src/foundation/geometry";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { FLAGS } from "../../src/spatial/node-store";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { BANK, fixtureIndex, ROCK } from "../helpers/fixture-index";
import { area, basin, coverage, point } from "../helpers/synthetic";
import { CHART_DATUM } from "../helpers/engine";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";

const NOW = Date.parse("2026-10-18T07:00:00Z");

function input(
  coordinates: LonLat[],
  draft: number,
  extra: Partial<RouteCheckInput> = {}
): RouteCheckInput {
  return {
    coordinates,
    departure: NOW,
    speeds: Array.from({ length: coordinates.length - 1 }, () => 2.5),
    xteLimit: 20,
    planningBuffer: 10,
    vessel: { draft, length: 12, beam: 4 },
    dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => CHART_DATUM,
    probability: 0.01,
    ...extra
  };
}

describe("corridor route check on the synthetic chart", () => {
  const index = fixtureIndex();
  const fairway: LonLat[] = [
    [22.004, 60.01],
    [22.03, 60.01]
  ];

  test("a deep keel fails on the rock in the swept fairway and names it", () => {
    const r = checkRoute(index, input(fairway, 3.6), NOW);
    const leg = r.legs[0];
    expect(leg?.status).toBe("fail");
    expect(leg?.charted).toBe(3.5);
    expect(leg?.minUkc).toBeLessThan(0);
    expect(leg?.risk).toBeGreaterThan(0.5);
    expect(leg?.sigma).toBeGreaterThan(0.3);
    expect(leg?.worst?.hazard).toMatchObject({ class: "UWTROC", lnam: "FI5-ROCK", valsou: 3.5 });
    expect(leg?.explanation).toMatchObject({
      charted: 3.5,
      draft: 3.6,
      waterLevel: 0,
      waterLevelSource: "chart-datum",
      flags: ["SWEPT"]
    });
    expect(leg?.explanation?.squat).toBeGreaterThan(0);
    expect(r.charts).toEqual([{ cell: "FI5SYNTH", edition: 3, update: 1 }]);
    expect(r.waterLevelSource).toBe("chart-datum");
  });

  test("a fallback water level leaves no leg ok", () => {
    const fallback = {
      ...CHART_DATUM,
      source: "fallback",
      degraded: "water level from fmi is 40 min old"
    };
    const ok = checkRoute(index, input(fairway, 1.5), NOW);
    expect(ok.legs[0]?.status).toBe("ok");
    const r = checkRoute(index, input(fairway, 1.5, { waterLevel: () => fallback }), NOW);
    expect(r.legs[0]?.status).toBe("unverified");
    expect(r.legs[0]?.flags).toContain("WATER_LEVEL_FALLBACK");
    expect(r.waterLevelDegraded).toBe("water level from fmi is 40 min old");
    expect(
      checkRoute(index, input(fairway, 3.6, { waterLevel: () => fallback }), NOW).legs[0]?.status
    ).toBe("fail");
  });

  test("P between the threshold and 5× it is marginal, below it ok", () => {
    const marginal = checkRoute(index, input(fairway, 2.8), NOW).legs[0];
    expect(marginal?.status).toBe("marginal");
    expect(marginal?.risk).toBeGreaterThanOrEqual(0.01);
    expect(marginal?.risk).toBeLessThan(0.05);
    const ok = checkRoute(index, input(fairway, 1.9), NOW).legs[0];
    expect(ok?.status).toBe("ok");
    expect(ok?.flags).toContain("SWEPT");
  });

  test("a stricter threshold turns ok into marginal", () => {
    const strict = checkRoute(index, input(fairway, 2.4, { probability: 1e-5 }), NOW).legs[0];
    const loose = checkRoute(index, input(fairway, 2.4), NOW).legs[0];
    expect(loose?.status).toBe("ok");
    expect(["marginal", "fail"]).toContain(strict?.status);
  });

  test("the lowest water level over the arrival interval is used", () => {
    const seen: [number, number][] = [];
    const r = checkRoute(
      index,
      input(fairway, 1.9, {
        waterLevel: (a, b) => {
          seen.push([a, b]);
          return { h: -1.4, sigma: 0.05, source: "test" };
        }
      }),
      NOW
    );
    expect(seen[0]?.[0]).toBe(NOW);
    expect(seen[0]?.[1]).toBeGreaterThan(NOW);
    expect(r.legs[0]?.status).toBe("fail");
    expect(r.legs[0]?.explanation?.waterLevel).toBe(-1.4);
    expect(r.waterLevelSource).toBe("test");
  });

  test("a leg into the coverage gap is unverified, never ok", () => {
    const r = checkRoute(
      index,
      input(
        [
          [22.03, 60.005],
          [22.045, 60.005]
        ],
        1.0
      ),
      NOW
    );
    expect(r.legs[0]?.status).toBe("unverified");
    expect(r.legs[0]?.flags).toContain("NO_COVERAGE");
  });

  test("a leg over the island fails with LAND", () => {
    const r = checkRoute(
      index,
      input(
        [
          [22.022, 60.0145],
          [22.034, 60.0145]
        ],
        1.0
      ),
      NOW
    );
    expect(r.legs[0]?.status).toBe("fail");
    expect(r.legs[0]?.flags).toContain("LAND");
    expect(r.legs[0]?.charted).toBeNull();
  });

  test("ETAs accumulate over legs at the given speeds", () => {
    const coords: LonLat[] = [
      [22.004, 60.012],
      [22.02, 60.012],
      [22.02, 60.018]
    ];
    const r = checkRoute(index, input(coords, 1.0, { speeds: [2, 4] }), NOW);
    const l0 = haversine(coords[0] as LonLat, coords[1] as LonLat);
    const l1 = haversine(coords[1] as LonLat, coords[2] as LonLat);
    expect(r.legs.map((l) => l.index)).toEqual([0, 1]);
    expect(Date.parse(r.legs[0]?.eta.end ?? "") - NOW).toBeCloseTo((l0 / 2) * 1000, -1);
    expect(r.legs[1]?.eta.start).toBe(r.legs[0]?.eta.end);
    expect(Date.parse(r.legs[1]?.eta.end ?? "") - NOW).toBeCloseTo((l0 / 2 + l1 / 4) * 1000, -1);
  });

  test("a long leg is checked along its whole length", () => {
    // 3.3 km due south from the north of band 4 onto the CATZOC C bank.
    const r = checkRoute(index, input([[BANK[0], 60.029], BANK], 1.9), NOW);
    expect(r.legs[0]?.status).toBe("fail");
    expect(r.legs[0]?.length).toBeGreaterThan(2500);
  });

  test("the hazard named for a leg is the shallowest one in its corridor", () => {
    const r = checkRoute(index, input([[22.016, 60.01], ROCK], 3.6), NOW);
    expect(r.legs[0]?.worst?.hazard?.lnam).toBe("FI5-ROCK");
  });

  test("a hazard shallower than the corridor's charted minimum is not named", () => {
    const rock = point(22.01, 60.005, 3, { lnam: "SET-MIN" });
    // The decoy is not in the pyramid, so it cannot have set the minimum.
    const decoy = point(22.01, 60.005, 1, { lnam: "DECOY" });
    const named: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: buildPyramid([...basin([22.0, 60.0, 22.02, 60.01], 10), rock], {
        minZoom: 12,
        leafZoom: 18
      }),
      hazards: new HazardIndex([decoy, rock])
    };
    const leg: LonLat[] = [
      [22.005, 60.005],
      [22.015, 60.005]
    ];
    const r = checkRoute(named, input(leg, 3.6), NOW);
    expect(r.legs[0]?.charted).toBe(3);
    expect(r.legs[0]?.worst?.hazard?.lnam).toBe("SET-MIN");
  });
});

describe("unassessed survey", () => {
  test("a corridor with no M_QUAL zone is unverified", () => {
    const box = [22.0, 60.0, 22.02, 60.01] as const;
    const index: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: buildPyramid([coverage(box), area(box, 20)], { minZoom: 12, leafZoom: 17 }),
      hazards: new HazardIndex([])
    };
    const r = checkRoute(
      index,
      input(
        [
          [22.005, 60.005],
          [22.015, 60.005]
        ],
        1.0
      ),
      NOW
    );
    expect(r.legs[0]?.status).toBe("unverified");
    expect(r.legs[0]?.flags).toContain("UNASSESSED");
    expect(r.charts).toEqual([]);
  });
});

describe("corridor geometry", () => {
  test("the corridor contains every point within r of the leg", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 10, max: 1000, noNaN: true }),
        fc.double({ min: 1, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        (brg, length, r, along, dir, frac) => {
          const a: LonLat = [22.0, 60.0];
          const b = project(a, brg, length);
          const p = project(project(a, brg, along * length), dir, frac * r);
          const ring = corridorRing(a, b, r).map((q) => toMercator(q[0], q[1]));
          const pm = toMercator(p[0], p[1]);
          expect(pointInPolygon(pm, { outer: ring, holes: [] })).toBe(true);
        }
      )
    );
  });

  test("the corridor stays close to the leg", () => {
    const a: LonLat = [22.0, 60.0];
    const b = project(a, 1, 500);
    const ma = toMercator(a[0], a[1]);
    const mb = toMercator(b[0], b[1]);
    const scale = 1 / Math.cos((60 * Math.PI) / 180);
    for (const q of corridorRing(a, b, 50)) {
      const d = pointSegmentDistance(toMercator(q[0], q[1]), ma, mb) / scale;
      expect(d).toBeLessThanOrEqual(50 * Math.SQRT2 + 1);
    }
  });

  test("flag names", () => {
    expect(flagNames(FLAGS.SWEPT | FLAGS.UNASSESSED)).toEqual(["SWEPT", "UNASSESSED"]);
    expect(flagNames(0)).toEqual([]);
  });
});
