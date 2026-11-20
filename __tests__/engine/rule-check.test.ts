import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkFootprint, checkRoute, corridorRing } from "../../src/engine/route-check";
import { departureWindow } from "../../src/engine/departure-window";
import { rhumbCourse } from "../../src/engine/corridor";
import { highestWaterLevel } from "../../src/model/water-level";
import { vesselFor } from "../../src/route-service";
import type { LonLat } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import type { RuleFeature } from "../../src/ingest/rule-features";
import { parseRuleLayer } from "../../src/ingest/rule-features";
import type { WaterLevel } from "../../src/model/uncertainty";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import { chartObjects } from "../../src/planning-objects";
import type { ChartIndex } from "../../src/spatial/chart-index";
import {
  isCurrentRules,
  meetsRing,
  readRules,
  RuleIndex,
  serializeRules
} from "../../src/spatial/rules";
import { CHART_DATUM } from "../helpers/engine";
import { fixtureIndex } from "../helpers/fixture-index";

/**
 * What a leg is held to besides depth (plan §4.11): bridges and overhead cables against the
 * boat's air height at the window's highest water, entry-prohibited areas, and the direction
 * of traffic in a separation scheme's lanes. On the synthetic fairway, which passes a 1.5 m
 * keel at chart datum.
 */

const NOW = Date.parse("2026-10-18T07:00:00Z");
const FAIRWAY: LonLat[] = [
  [22.004, 60.01],
  [22.03, 60.01]
];
const merc = (p: LonLat) => toMercator(p[0], p[1]);
/** A line across the fairway at 22.017° E. */
const ACROSS = { type: "line" as const, coords: [merc([22.017, 60.005]), merc([22.017, 60.015])] };
/** An area over the fairway's middle. */
const OVER = {
  type: "polygon" as const,
  polygons: [
    {
      outer: [
        merc([22.015, 60.008]),
        merc([22.02, 60.008]),
        merc([22.02, 60.012]),
        merc([22.015, 60.012])
      ],
      holes: []
    }
  ]
};

/** The fixture index with `rules`, its cell's heights and depths on the datum `verdat`. */
function withRules(rules: RuleFeature[], verdat: number | undefined = 3): ChartIndex {
  const base = fixtureIndex();
  return {
    ...base,
    catalogue: {
      ...base.catalogue,
      cells: base.catalogue.cells.map((c) => ({
        ...c,
        verticalDatum: verdat,
        soundingDatum: verdat
      }))
    },
    rules: new RuleIndex(rules)
  };
}

const level = (h: number, extra: Partial<WaterLevel> = {}): WaterLevel => ({
  h,
  sigma: 0.1,
  source: "test",
  ...extra
});

function input(extra: Partial<RouteCheckInput> = {}, airHeight?: number): RouteCheckInput {
  return {
    coordinates: FAIRWAY,
    departure: NOW,
    speeds: [2.5],
    xteLimit: 20,
    planningBuffer: 10,
    vessel: { draft: 1.5, length: 12, beam: 4, ...(airHeight !== undefined && { airHeight }) },
    dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => CHART_DATUM,
    highWater: () => level(0),
    probability: 0.01,
    ...extra
  };
}

const bridge = (clearance?: number): RuleFeature => ({
  objectClass: "BRIDGE",
  geom: ACROSS,
  cellRef: 0,
  ...(clearance !== undefined && { clearance })
});

const leg = (index: ChartIndex, i: RouteCheckInput) => checkRoute(index, i, NOW).legs[0];

describe("air height under a bridge", () => {
  const index = withRules([bridge(18)]);

  test("a 17 m mast passes under an 18 m bridge at chart datum", () => {
    expect(leg(index, input({}, 17))).toMatchObject({ status: "ok" });
  });

  test("the bridge fixture blocks the same mast at high water", () => {
    const high = leg(index, input({ highWater: () => level(1) }, 17));
    expect(high?.status).toBe("fail");
    expect(high?.flags).toContain("AIR_DRAFT");
  });

  test("a mast taller than the clearance fails whatever the water", () => {
    expect(leg(index, input({}, 18))?.flags).toContain("AIR_DRAFT");
  });

  test("without an air height the bridge is not checked", () => {
    const r = leg(index, input({ highWater: () => level(5) }));
    expect(r?.status).toBe("ok");
    expect(r?.flags).not.toContain("AIR_DRAFT");
  });

  test("a bridge with no stated clearance leaves the leg unverified", () => {
    const r = leg(withRules([bridge()]), input({}, 3));
    expect(r?.status).toBe("unverified");
    expect(r?.flags).toContain("CLEARANCE_UNKNOWN");
  });

  test("a fallback water level cannot bound the rise: a close clearance is unverified", () => {
    const fallback = () => level(0, { degraded: "no water level" });
    expect(leg(index, input({ highWater: fallback }, 17))?.status).toBe("unverified");
    // A clearance well over the mast passes, marked for the rise it takes, never silently.
    const clear = leg(index, input({ highWater: fallback }, 12));
    expect(clear?.status).toBe("ok");
    expect(clear?.flags).toContain("CLEARANCE_RISE_ASSUMED");
  });

  test("the object's own datum wins over its cell's, and a cell of datum areas gives none", () => {
    // Heights above HAT in the cell, but the bridge's clearance is on mean water, as its depths.
    const own = withRules([{ ...bridge(18), verdat: 3 }], 30);
    const ownCells = own.catalogue.cells.map((c) => ({ ...c, soundingDatum: 3 }));
    const mixed = { ...own, catalogue: { ...own.catalogue, cells: ownCells } };
    expect(leg(mixed, input({ highWater: () => level(1) }, 17))?.flags).toContain("AIR_DRAFT");
    const areas = withRules([bridge(20)], 30);
    const withAreas = {
      ...areas,
      catalogue: {
        ...areas.catalogue,
        cells: areas.catalogue.cells.map((c) => ({ ...c, datumAreas: [3] }))
      }
    };
    expect(leg(withAreas, input({}, 17))).toMatchObject({
      status: "ok",
      flags: expect.arrayContaining(["CLEARANCE_RISE_ASSUMED"])
    });
  });

  test("a clearance above HAT holds at any water; one above MHWS allows for a rise past it", () => {
    const hat = withRules([bridge(18)], 30);
    expect(leg(hat, input({ highWater: () => level(9) }, 17))?.status).toBe("ok");
    const mhws = withRules([bridge(18)], 17);
    expect(leg(mhws, input({}, 17))?.status).toBe("ok");
    expect(leg(mhws, input({}, 17.2))?.status).toBe("fail");
  });

  test("the planning API's box under the bridge fails for the mast at high water", () => {
    const ring = corridorRing([22.016, 60.01], [22.018, 60.01], 30);
    const box = (h: number) =>
      checkFootprint(index, input({ highWater: () => level(h) }, 17), ring, 2.5, {
        start: NOW,
        end: NOW + 3_600_000,
        at: ring
      });
    expect(box(0).status).toBe("ok");
    expect(box(1)).toMatchObject({ status: "fail", flags: expect.arrayContaining(["AIR_DRAFT"]) });
  });

  test("the departure window rounds a high water up, never giving the bridge more room", async () => {
    // 18 m less 0.501 m is under the 17.5 m the mast needs; rounded down it would just pass.
    const w = await departureWindow(
      index,
      input({ highWater: () => level(0.501, { sigma: 0 }) }, 17),
      NOW,
      NOW,
      30 * 60_000
    );
    expect(w.steps.map((s) => s.status)).toEqual(["fail"]);
  });

  test("the departure window keeps each departure's own high water", async () => {
    // High water for departures from the second hour on.
    const tide = (start: number) => level(start >= NOW + 3_600_000 ? 1 : 0);
    const w = await departureWindow(
      index,
      input({ highWater: (start) => tide(start) }, 17),
      NOW,
      NOW + 2 * 3_600_000,
      30 * 60_000
    );
    expect(w.steps.map((s) => s.status)).toEqual(["ok", "ok", "fail", "fail", "fail"]);
  });
});

describe("restricted areas and traffic lanes", () => {
  test("an entry-prohibited area fails the leg; an area to be avoided is only named", () => {
    const prohibited = withRules([
      { objectClass: "RESARE", geom: OVER, cellRef: 0, restrictions: [7] }
    ]);
    expect(leg(prohibited, input())).toMatchObject({
      status: "fail",
      flags: expect.arrayContaining(["ENTRY_PROHIBITED"])
    });
    const avoid = withRules([
      { objectClass: "RESARE", geom: OVER, cellRef: 0, restrictions: [14] }
    ]);
    expect(leg(avoid, input())).toMatchObject({
      status: "ok",
      flags: expect.arrayContaining(["AREA_TO_BE_AVOIDED"])
    });
  });

  test("a lane is followed its own way, crossed near a right angle, never against it", () => {
    const lane = (orient: number) =>
      withRules([{ objectClass: "TSSLPT", geom: OVER, cellRef: 0, orient }]);
    // The fairway runs east, 90°.
    expect(leg(lane(90), input())?.status).toBe("ok");
    expect(leg(lane(0), input())?.status).toBe("ok");
    const against = leg(lane(270), input());
    expect(against?.status).toBe("fail");
    expect(against?.flags).toEqual(expect.arrayContaining(["TRAFFIC_LANE", "TSS_WRONG_WAY"]));
    expect(leg(lane(25), input())?.status).toBe("fail");
  });

  test("a box in a lane has no course to judge, and is only named", () => {
    const index = withRules([{ objectClass: "TSSLPT", geom: OVER, cellRef: 0, orient: 270 }]);
    const ring = corridorRing([22.016, 60.01], [22.018, 60.01], 30);
    const v = checkFootprint(index, input(), ring, 2.5, {
      start: NOW,
      end: NOW + 60_000,
      at: ring
    });
    expect(v).toMatchObject({ status: "ok", flags: expect.arrayContaining(["TRAFFIC_LANE"]) });
  });
});

describe("rule features", () => {
  test("S-57 attributes as GDAL writes them: lists as arrays or strings, closed clearance first", () => {
    const line = {
      type: "LineString",
      coordinates: [
        [22, 60],
        [22.1, 60]
      ]
    };
    const collection = (props: Record<string, unknown>) => ({
      type: "FeatureCollection" as const,
      features: [{ type: "Feature" as const, geometry: line, properties: props }]
    });
    const [opening] = parseRuleLayer(
      "BRIDGE",
      collection({ VERCCL: "4.5", VERCOP: 30, VERCLR: 12 }),
      2
    );
    expect(opening).toMatchObject({ objectClass: "BRIDGE", clearance: 4.5, cellRef: 2 });
    const [cable] = parseRuleLayer("CBLOHD", collection({ VERCSA: 21 }), 0);
    expect(cable?.clearance).toBe(21);
    // A cable at its safe clearance, below its physical one.
    const [safe] = parseRuleLayer("CBLOHD", collection({ VERCLR: 25, VERCSA: 21 }), 0);
    expect(safe?.clearance).toBe(21);
    const [bridged] = parseRuleLayer("BRIDGE", collection({ VERCLR: 12, VERDAT: "3" }), 0);
    expect(bridged).toMatchObject({ clearance: 12, verdat: 3 });
    const [area] = parseRuleLayer("RESARE", collection({ RESTRN: ["7", "14"] }), 0);
    expect(area?.restrictions).toEqual([7, 14]);
    const [listed] = parseRuleLayer("RESARE", collection({ RESTRN: "8,14" }), 0);
    expect(listed?.restrictions).toEqual([8, 14]);
    const [lane] = parseRuleLayer("TSSLPT", collection({ ORIENT: -90 }), 0);
    expect(lane?.orient).toBe(270);
    // What a planner keeps to: a leading line with its direction, a two-way recommended track.
    const [leading] = parseRuleLayer("NAVLNE", collection({ ORIENT: 135 }), 0);
    expect(leading).toMatchObject({ objectClass: "NAVLNE", orient: 135 });
    expect(leading?.twoWay).toBeUndefined();
    const [both] = parseRuleLayer("RECTRC", collection({ TRAFIC: "4" }), 0);
    expect(both?.twoWay).toBe(true);
    const [inbound] = parseRuleLayer("RECTRC", collection({ TRAFIC: 1 }), 0);
    expect(inbound?.twoWay).toBeUndefined();
  });

  test("rules.json round-trips; another version or a short file is refused", () => {
    const index = new RuleIndex([bridge(18)]);
    const text = serializeRules(index);
    expect(isCurrentRules(text.slice(0, 512))).toBe(true);
    expect(readRules(text).features()).toEqual(index.features());
    expect(() => readRules(text.replace('"version":2', '"version":3'))).toThrow();
    expect(() => readRules(text.replace('"count":1', '"count":2'))).toThrow();
    // A coordinate past any number is refused rather than looped over.
    const huge = JSON.parse(text) as { features: { geom: { coords: number[][] } }[] };
    (huge.features[0]?.geom.coords[0] as number[])[0] = Number.POSITIVE_INFINITY;
    expect(() => readRules(JSON.stringify(huge).replace("null", "1e309"))).toThrow();
  });

  test("a corridor meets a line across it, an area holding it, and nothing beside it", () => {
    const ring = corridorRing([22.016, 60.01], [22.018, 60.01], 30).map(merc);
    expect(meetsRing(ACROSS, ring)).toBe(true);
    expect(meetsRing(OVER, ring)).toBe(true);
    const beside = {
      type: "line" as const,
      coords: [merc([22.017, 60.02]), merc([22.018, 60.03])]
    };
    expect(meetsRing(beside, ring)).toBe(false);
    const big = {
      type: "polygon" as const,
      polygons: [
        {
          outer: [merc([21, 59]), merc([23, 59]), merc([23, 61]), merc([21, 61])],
          holes: []
        }
      ]
    };
    expect(meetsRing(big, ring)).toBe(true);
    // A second polygon inside the corridor meets it though the first lies outside.
    const parts = {
      type: "polygon" as const,
      polygons: [
        {
          outer: [merc([23, 61]), merc([23.1, 61]), merc([23.1, 61.1]), merc([23, 61.1])],
          holes: []
        },
        {
          outer: [
            merc([22.0168, 60.0099]),
            merc([22.0172, 60.0099]),
            merc([22.0172, 60.0101]),
            merc([22.0168, 60.0101])
          ],
          holes: []
        }
      ]
    };
    expect(meetsRing(parts, ring)).toBe(true);
  });

  test("the planning API lists the objects in a box in lon/lat, with the cell they are from", () => {
    const index = withRules([bridge(18)]);
    const [o] = chartObjects(index, [22.0, 60.0], [22.05, 60.02]);
    expect(o).toMatchObject({ class: "BRIDGE", clearance: 18, cell: "FI5SYNTH" });
    expect(o?.geometry.type).toBe("LineString");
    const [lon, lat] = (o?.geometry.coordinates as LonLat[])[0] as LonLat;
    expect(lon).toBeCloseTo(22.017, 6);
    expect(lat).toBeCloseTo(60.005, 6);
    expect(chartObjects(index, [22.1, 60.1], [22.2, 60.2])).toEqual([]);
    // Its copy of the restrictions cannot change the index.
    const area = withRules([{ objectClass: "RESARE", geom: OVER, cellRef: 0, restrictions: [7] }]);
    chartObjects(area, [22.0, 60.0], [22.05, 60.02])[0]?.restrictions?.splice(0);
    expect(leg(area, input())?.flags).toContain("ENTRY_PROHIBITED");
    // The lookup walks the grid over the whole box: a box past 40 000 km² is refused.
    expect(() => chartObjects(index, [0, 50], [10, 70])).toThrow(RangeError);
  });
});

describe("what a planner keeps to", () => {
  test("leading lines, tracks and anchorages are listed, and no verdict reads them", () => {
    const index = withRules([
      { objectClass: "NAVLNE", geom: ACROSS, cellRef: 0, orient: 0 },
      { objectClass: "ACHARE", geom: OVER, cellRef: 0 },
      { objectClass: "NAVLINE", geom: ACROSS, cellRef: 0, twoWay: true, designDraft: 2.4 }
    ]);
    // The leg is just what it is without them.
    expect(leg(index, input({}, 30))).toEqual(leg(withRules([]), input({}, 30)));
    const objects = chartObjects(index, [22.0, 60.0], [22.05, 60.02]);
    expect(objects.map((o) => o.class).sort()).toEqual(["ACHARE", "NAVLINE", "NAVLNE"]);
    expect(objects.find((o) => o.class === "NAVLINE")).toMatchObject({
      twoWay: true,
      designDraft: 2.4
    });
  });
});

describe("rules at the edges of the chart", () => {
  test("a corridor across ±180° finds the bridge on the far side", () => {
    const across = {
      objectClass: "BRIDGE" as const,
      geom: {
        type: "line" as const,
        coords: [merc([-179.9998, 59.999]), merc([-179.9998, 60.001])]
      },
      cellRef: 0,
      clearance: 18
    };
    const index = withRules([across]);
    const r = checkRoute(
      index,
      input(
        {
          highWater: () => level(1),
          coordinates: [
            [179.999, 60],
            [179.9998, 60]
          ]
        },
        17
      ),
      NOW
    ).legs[0];
    expect(r?.flags).toContain("AIR_DRAFT");
  });

  test("a lane's direction is compared with the course the chart draws, the rhumb line", () => {
    // The tangent plane gives 41°, the rhumb line 38°: a lane at 339° is followed, 59° off it.
    expect(rhumbCourse([0, 75], [10, 78])).toBeCloseTo(38, 0);
  });

  test("with no water-level source the high water is no bound on the rise", () => {
    expect(
      highestWaterLevel(undefined, [], undefined, NOW, NOW + 60_000, NOW).degraded
    ).toBeDefined();
  });

  test("a request's draft for an unresolved vessel keeps the configured air height", () => {
    const v = vesselFor({ draft: 2 }, { vessel: () => undefined, airHeight: () => 17 });
    expect(v?.airHeight).toBe(17);
    expect(
      vesselFor({ draft: 2, airHeight: 12 }, { vessel: () => undefined, airHeight: () => 17 })
        ?.airHeight
    ).toBe(12);
  });
});
