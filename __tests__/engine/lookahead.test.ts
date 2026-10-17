import type { NavState } from "../../src/engine/lookahead";
import {
  DEFAULT_LOOKAHEAD,
  describe as explain,
  evaluateLookahead
} from "../../src/engine/lookahead";
import type { VesselModel } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { BANK, FAIRWAY_LAT, fixtureIndex, M_PER_DEG_LON, ROCK } from "../helpers/fixture-index";
import { basin, point } from "../helpers/synthetic";

const NOW = 1_800_000_000_000;
const DEEP_KEEL: VesselModel = { draft: 3.2, length: 12, beam: 4 };
const SHALLOW_KEEL: VesselModel = { draft: 1.9, length: 12, beam: 4 };
const EAST = Math.PI / 2;

function nav(lon: number, lat: number, cog = EAST, sog = 3, age = 0): NavState {
  const at = NOW - age * 1000;
  return {
    position: { value: [lon, lat], at },
    cog: { value: cog, at },
    sog: { value: sog, at },
    heading: { value: cog, at }
  };
}

/** Longitude `seconds` of 3 m/s travel west of the rock. */
const westOfRock = (seconds: number) => ROCK[0] - (3 * seconds) / M_PER_DEG_LON;

describe("deterministic look-ahead on the synthetic chart", () => {
  const index = fixtureIndex();

  test("the swept fairway away from the rock is normal", () => {
    const r = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 1), DEEP_KEEL, index, NOW);
    expect(r.state).toBe("normal");
    expect(r.reason).toBe("");
    expect(r.clearance).toBeGreaterThan(0);
    expect(r.timeToShoal).toBeNull();
  });

  test("the rock far ahead is an alert, nearer a warn, close an alarm", () => {
    const far = evaluateLookahead(nav(westOfRock(170), FAIRWAY_LAT), DEEP_KEEL, index, NOW);
    expect(far.state).toBe("alert");
    expect(far.timeToShoal).toBeGreaterThan(120);
    const mid = evaluateLookahead(nav(westOfRock(90), FAIRWAY_LAT), DEEP_KEEL, index, NOW);
    expect(mid.state).toBe("warn");
    const near = evaluateLookahead(nav(westOfRock(25), FAIRWAY_LAT), DEEP_KEEL, index, NOW);
    expect(near.state).toBe("alarm");
    expect(near.timeToShoal).toBeLessThanOrEqual(30);
    expect(near.worst?.hazard).toMatchObject({ class: "UWTROC", lnam: "FI5-ROCK", depth: 3.5 });
    expect(near.worst?.cell).toEqual({ name: "FI5SYNTH", edition: 3, update: 1 });
  });

  test("a shallower keel passes over the rock", () => {
    const r = evaluateLookahead(nav(westOfRock(25), FAIRWAY_LAT), SHALLOW_KEEL, index, NOW);
    expect(r.state).toBe("normal");
  });

  test("on the bank the shoal is under the vessel", () => {
    const r = evaluateLookahead(nav(BANK[0], BANK[1], 0, 0), SHALLOW_KEEL, index, NOW);
    expect(r.state).toBe("alarm");
    expect(r.timeToShoal).toBe(0);
    expect(r.reason).toBe("shoal under the vessel");
  });

  test("no coverage ahead is a warn, never normal", () => {
    const r = evaluateLookahead(nav(22.0355, 60.005, EAST, 3), SHALLOW_KEEL, index, NOW);
    expect(r.state).toBe("warn");
    expect(r.reason).toMatch(/no chart coverage ahead/);
  });

  test("a rock in the charted part of a footprint at the coverage edge still alarms", () => {
    const features = [...basin([22.0, 60.0, 22.02, 60.01], 10), point(22.0195, 60.005, 1.0)];
    const store = buildPyramid(features, { minZoom: 12, leafZoom: 18 });
    const edge: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: store,
      hazards: new HazardIndex([])
    };
    const r = evaluateLookahead(nav(22.0193, 60.005, EAST, 0.1), SHALLOW_KEEL, edge, NOW);
    expect(r.state).toBe("alarm");
    expect(r.footprints[0]?.uncovered).toBe(true);
  });

  test("outside every chart is a warn at the vessel", () => {
    const r = evaluateLookahead(nav(23, 61, EAST, 3), SHALLOW_KEEL, index, NOW);
    expect(r.state).toBe("warn");
    expect(r.reason).toBe("no chart coverage at the vessel");
    expect(r.clearance).toBeNull();
  });

  test("low speed checks only the current position", () => {
    const r = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 0.1), DEEP_KEEL, index, NOW);
    expect(r.state).toBe("normal");
    expect(r.horizon).toBe(0);
    expect(r.footprints).toHaveLength(1);
    expect(r.reason).toMatch(/low speed/);
  });

  test("stale course or speed is unknown even in deep water", () => {
    const n = nav(22.003, FAIRWAY_LAT);
    n.cog = { value: EAST, at: NOW - 60_000 };
    const r = evaluateLookahead(n, DEEP_KEEL, index, NOW);
    expect(r.state).toBe("unknown");
    expect(r.reason).toMatch(/course or speed stale/);
  });

  test("stale course over a shoal still alarms", () => {
    const n = nav(BANK[0], BANK[1]);
    delete n.sog;
    expect(evaluateLookahead(n, SHALLOW_KEEL, index, NOW).state).toBe("alarm");
  });

  test("stale or missing inputs never produce normal", () => {
    expect(
      evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 3, 11), DEEP_KEEL, index, NOW)
    ).toMatchObject({
      state: "unknown",
      reason: "position stale"
    });
    expect(evaluateLookahead({}, DEEP_KEEL, index, NOW)).toMatchObject({
      state: "unknown",
      reason: "no position"
    });
    expect(evaluateLookahead(nav(22.003, FAIRWAY_LAT), undefined, index, NOW)).toMatchObject({
      state: "unknown",
      reason: "vessel draft not configured"
    });
    expect(evaluateLookahead(nav(22.003, FAIRWAY_LAT), DEEP_KEEL, undefined, NOW)).toMatchObject({
      state: "off",
      reason: "no chart index loaded"
    });
  });

  test("land ahead is a shoal", () => {
    // The island spans 22.025–22.03 E, 60.013–60.016 N; approach from the west at 60.0145.
    const r = evaluateLookahead(nav(22.022, 60.0145, EAST, 3), SHALLOW_KEEL, index, NOW);
    expect(["warn", "alarm"]).toContain(r.state);
    expect(r.worst?.charted).toBe(-Infinity);
  });

  test("the horizon follows max(minHorizon, distance / SOG)", () => {
    const slow = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 2), DEEP_KEEL, index, NOW);
    expect(slow.horizon).toBeCloseTo(DEFAULT_LOOKAHEAD.distance / 2, 6);
    const fast = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 20), DEEP_KEEL, index, NOW);
    expect(fast.horizon).toBe(60);
  });

  test("the explanation names every term", () => {
    const r = evaluateLookahead(nav(westOfRock(25), FAIRWAY_LAT), DEEP_KEEL, index, NOW);
    expect(explain(r)).toMatch(
      /^shoal ahead in \d+ s: charted 3\.5 m \(UWTROC FI5-ROCK\) − draft 3\.2 m − margin 0\.5 m → UKC -0\.2 m$/
    );
    expect(explain(evaluateLookahead({}, DEEP_KEEL, index, NOW))).toBe("no position");
  });
});
