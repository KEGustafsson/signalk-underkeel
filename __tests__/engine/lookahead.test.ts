import type { FootprintResult, NavState } from "../../src/engine/lookahead";
import {
  DEFAULT_LOOKAHEAD,
  MAX_FOOTPRINTS,
  describe as explain,
  evaluateLookahead,
  navState
} from "../../src/engine/lookahead";
import { Hysteresis } from "../../src/engine/hysteresis";
import { haversine } from "../../src/foundation/geo";
import type { VesselModel } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { CHART_DATUM, ctx } from "../helpers/engine";
import { BANK, FAIRWAY_LAT, fixtureIndex, M_PER_DEG_LON, ROCK } from "../helpers/fixture-index";
import { area, basin, coverage, point, quality } from "../helpers/synthetic";

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

describe("probabilistic look-ahead on the synthetic chart", () => {
  const index = fixtureIndex();

  test("the swept fairway away from the rock is normal with a small σ", () => {
    const r = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 1), ctx(DEEP_KEEL), index, NOW);
    expect(r.state).toBe("normal");
    expect(r.reason).toBe("");
    expect(r.clearance).toBeGreaterThan(4);
    expect(r.risk).toBeLessThan(0.01);
    // The fan's COG ± 5° members reach the edge tile of the swept area, which
    // carries the A2 σD 0.58 m beside the swept 8 m; its P is still negligible.
    expect(r.clearanceSigma).toBeLessThan(0.7);
    expect(r.risk).toBeLessThan(1e-6);
    expect(r.timeToShoal).toBeNull();
  });

  test("clearance and its σ come from the same footprint", () => {
    for (const lon of [westOfRock(170), westOfRock(25), 22.003, 22.022]) {
      const r = evaluateLookahead(nav(lon, FAIRWAY_LAT), ctx(DEEP_KEEL), index, NOW);
      const charted = r.footprints.filter((f) => f.mean !== null);
      const min = Math.min(...charted.map((f) => f.mean as number));
      const atMin = charted.filter((f) => f.mean === min);
      expect(r.clearance).toBe(min);
      expect(r.clearanceSigma).toBe(Math.max(...atMin.map((f) => f.sigma)));
    }
  });

  test("the rock far ahead is an alert, nearer a warn, close an alarm", () => {
    const far = evaluateLookahead(nav(westOfRock(170), FAIRWAY_LAT), ctx(DEEP_KEEL), index, NOW);
    expect(far.state).toBe("alert");
    expect(far.timeToShoal).toBeGreaterThan(120);
    const mid = evaluateLookahead(nav(westOfRock(100), FAIRWAY_LAT), ctx(DEEP_KEEL), index, NOW);
    expect(mid.state).toBe("warn");
    expect(mid.timeToShoal).toBeLessThanOrEqual(120);
    const near = evaluateLookahead(nav(westOfRock(40), FAIRWAY_LAT), ctx(DEEP_KEEL), index, NOW);
    expect(near.state).toBe("alarm");
    expect(near.risk).toBeGreaterThanOrEqual(0.2);
    const e = near.worst?.explanation;
    expect(e?.hazard).toMatchObject({ class: "UWTROC", lnam: "FI5-ROCK", depth: 3.5 });
    expect(e?.cell).toEqual({ name: "FI5SYNTH", edition: 3, update: 1 });
    expect(e?.flags).toContain("SWEPT");
    // The sweep guarantees 8 m, not the rock's 3.5 m: the rock keeps the A2 σ.
    expect(e?.sigmaCharted).toBeCloseTo(0.54, 6);
  });

  test("a shallower keel passes over the rock", () => {
    const r = evaluateLookahead(nav(westOfRock(25), FAIRWAY_LAT), ctx(SHALLOW_KEEL), index, NOW);
    expect(r.state).toBe("normal");
  });

  test("on the CATZOC C bank the shoal is under the vessel", () => {
    const r = evaluateLookahead(nav(BANK[0], BANK[1], 0, 0), ctx(SHALLOW_KEEL), index, NOW);
    expect(r.state).toBe("alarm");
    expect(r.reason).toBe("shoal under the vessel");
    expect(r.timeToShoal).toBe(0);
    expect(r.worst?.explanation.sigmaCharted).toBeGreaterThan(1);
  });

  test("a higher water level lifts the bank clear, a lower one does not", () => {
    const high = { h: 1.5, sigma: 0.05, source: "manual" };
    const r = evaluateLookahead(nav(BANK[0], BANK[1], 0, 0), ctx(SHALLOW_KEEL, high), index, NOW);
    expect(r.risk).toBeLessThan(0.5);
    const low = { h: -0.5, sigma: 0.05, source: "manual" };
    const s = evaluateLookahead(nav(BANK[0], BANK[1], 0, 0), ctx(SHALLOW_KEEL, low), index, NOW);
    expect(s.risk).toBeGreaterThan(r.risk ?? 1);
  });

  test("squat and wave allowance add to the draft", () => {
    const calm = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 1), ctx(DEEP_KEEL), index, NOW);
    const n = nav(22.003, FAIRWAY_LAT, EAST, 6);
    n.waveHeight = { value: 1.0, at: NOW };
    const rough = evaluateLookahead(n, ctx(DEEP_KEEL), index, NOW);
    expect(rough.clearance).toBeLessThan((calm.clearance as number) - 0.5);
  });

  test("a degraded water level is never normal", () => {
    const fallback = { ...CHART_DATUM, source: "fallback", degraded: "water level stale" };
    const r = evaluateLookahead(
      nav(22.003, FAIRWAY_LAT, EAST, 1),
      ctx(DEEP_KEEL, fallback),
      index,
      NOW
    );
    expect(r.state).toBe("alert");
    expect(r.reason).toBe("water level stale");
  });

  test("no coverage ahead is a warn, never normal", () => {
    const r = evaluateLookahead(nav(22.0355, 60.005, EAST, 3), ctx(SHALLOW_KEEL), index, NOW);
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
    const r = evaluateLookahead(nav(22.0193, 60.005, EAST, 0.1), ctx(SHALLOW_KEEL), edge, NOW);
    expect(r.state).toBe("alarm");
    expect(r.footprints[0]?.uncovered).toBe(true);
  });

  test("outside every chart is a warn at the vessel", () => {
    const r = evaluateLookahead(nav(23, 61, EAST, 3), ctx(SHALLOW_KEEL), index, NOW);
    expect(r.state).toBe("warn");
    expect(r.reason).toBe("no chart coverage at the vessel");
    expect(r.clearance).toBeNull();
    expect(r.worst).toBeUndefined();
  });

  test("low speed checks only the current position", () => {
    const r = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 0.1), ctx(DEEP_KEEL), index, NOW);
    expect(r.state).toBe("normal");
    expect(r.horizon).toBe(0);
    expect(r.footprints).toHaveLength(1);
    expect(r.reason).toMatch(/low speed/);
  });

  test("stale course or speed is unknown even in deep water", () => {
    const n = nav(22.003, FAIRWAY_LAT);
    n.cog = { value: EAST, at: NOW - 60_000 };
    const r = evaluateLookahead(n, ctx(DEEP_KEEL), index, NOW);
    expect(r.state).toBe("unknown");
    expect(r.reason).toMatch(/course or speed stale/);
  });

  test("stale course over a shoal still alarms", () => {
    const n = nav(BANK[0], BANK[1]);
    delete n.sog;
    expect(evaluateLookahead(n, ctx(SHALLOW_KEEL), index, NOW).state).toBe("alarm");
  });

  test("stale or missing inputs never produce normal", () => {
    expect(
      evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 3, 11), ctx(DEEP_KEEL), index, NOW)
    ).toMatchObject({ state: "unknown", reason: "position stale" });
    expect(evaluateLookahead({}, ctx(DEEP_KEEL), index, NOW)).toMatchObject({
      state: "unknown",
      reason: "no position"
    });
    expect(evaluateLookahead(nav(22.003, FAIRWAY_LAT), ctx(undefined), index, NOW)).toMatchObject({
      state: "unknown",
      reason: "vessel draft not configured"
    });
    expect(
      evaluateLookahead(nav(22.003, FAIRWAY_LAT), ctx(DEEP_KEEL), undefined, NOW)
    ).toMatchObject({ state: "off", reason: "no chart index loaded" });
  });

  test("non-finite navigation input is unknown, never normal", () => {
    expect(evaluateLookahead(nav(NaN, FAIRWAY_LAT), ctx(DEEP_KEEL), index, NOW)).toMatchObject({
      state: "unknown",
      reason: "non-finite navigation input"
    });
    const n = nav(22.003, FAIRWAY_LAT);
    n.sog = { value: Infinity, at: NOW };
    expect(evaluateLookahead(n, ctx(DEEP_KEEL), index, NOW).state).toBe("unknown");
  });

  test("a footprint that visits no tile is uncovered, never normal", () => {
    const r = evaluateLookahead(nav(500, FAIRWAY_LAT, EAST, 0.1), ctx(DEEP_KEEL), index, NOW);
    expect(r.footprints[0]?.uncovered).toBe(true);
    expect(r.state).not.toBe("normal");
  });

  test("only a hazard at the charted minimum is named", () => {
    const at: [number, number] = [22.01, 60.005];
    const rock = point(at[0], at[1], 3, { lnam: "SET-MIN" });
    const decoy = point(at[0], at[1], 1, { lnam: "DECOY" });
    const named: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      // The decoy is not in the pyramid, so it cannot have set the minimum.
      pyramid: buildPyramid([...basin([22.0, 60.0, 22.02, 60.01], 10), rock], {
        minZoom: 12,
        leafZoom: 18
      }),
      hazards: new HazardIndex([decoy, rock])
    };
    const r = evaluateLookahead(nav(at[0], at[1], EAST, 0), ctx(DEEP_KEEL), named, NOW);
    expect(r.worst?.explanation.charted).toBe(3);
    expect(r.worst?.explanation.hazard?.lnam).toBe("SET-MIN");
  });

  test("land ahead is certain", () => {
    // The island spans 22.025–22.03 E, 60.013–60.016 N; approach from the west at 60.0145.
    const r = evaluateLookahead(nav(22.022, 60.0145, EAST, 3), ctx(SHALLOW_KEEL), index, NOW);
    expect(r.state).toBe("alarm");
    expect(r.worst?.explanation.charted).toBeNull();
    expect(r.worst?.explanation.risk).toBe(1);
    // -Infinity would not survive JSON and breaks database writers subscribed in-process.
    expect(r.clearance).toBeNull();
  });

  test("footprints start where the vessel is now, not at an older fix", () => {
    // A fix 5 s old at 3 m/s is 15 m behind the vessel.
    const aged = evaluateLookahead(
      nav(westOfRock(40) - 15 / M_PER_DEG_LON, FAIRWAY_LAT, EAST, 3, 5),
      { ...ctx(DEEP_KEEL), escape: true },
      index,
      NOW
    );
    const now = evaluateLookahead(
      nav(westOfRock(40), FAIRWAY_LAT),
      { ...ctx(DEEP_KEEL), escape: true },
      index,
      NOW
    );
    expect(aged.footprints.map((f) => f.t)).toEqual(now.footprints.map((f) => f.t));
    aged.footprints.forEach((f, i) => {
      expect(haversine(f.center, (now.footprints[i] as FootprintResult).center)).toBeLessThan(0.1);
    });
    // Speed error since the fix lengthens the aged footprints: the shoal comes no later.
    expect(aged.state).toBe(now.state);
    expect(aged.timeToShoal as number).toBeLessThanOrEqual(now.timeToShoal as number);
    // The escape turns from where the vessel is now, not from the fix.
    expect(now.escapeHeading).not.toBeNull();
    expect(aged.escapeHeading).toBe(now.escapeHeading);
  });

  test("the horizon follows max(minHorizon, distance / SOG)", () => {
    const slow = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 2), ctx(DEEP_KEEL), index, NOW);
    expect(slow.horizon).toBeCloseTo(DEFAULT_LOOKAHEAD.distance / 2, 6);
    const fast = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 20), ctx(DEEP_KEEL), index, NOW);
    expect(fast.horizon).toBe(60);
  });

  test("the explanation names every term", () => {
    const r = evaluateLookahead(nav(westOfRock(40), FAIRWAY_LAT), ctx(DEEP_KEEL), index, NOW);
    expect(explain(r)).toMatch(
      /^shoal ahead in \d+ s: charted 3\.5 m UWTROC FI5-ROCK \(±0\.54 m, SWEPT\) \+ 0 m water level \(chart-datum\) − draft 3\.2 m − squat 0\.14 m \+ heel 0 m − wave 0 m → μ = 0\.16 m, σ = 0\.6\d m, P = \d+ %$/
    );
    expect(explain(evaluateLookahead({}, ctx(DEEP_KEEL), index, NOW))).toBe("no position");
  });

  test("a turn toward the rock is caught by the fan; the same track held straight passes", () => {
    // 150 m west of the rock and 140 m north of it, heading east: straight
    // runs clear to the north; a 1.2°/s turn to starboard curves onto it.
    const start = nav(ROCK[0] - 150 / M_PER_DEG_LON, ROCK[1] + 140 / 111320, EAST, 3);
    const straight = evaluateLookahead(start, ctx(DEEP_KEEL), index, NOW);
    const turning = evaluateLookahead(
      { ...start, rot: { value: (1.2 * Math.PI) / 180, at: NOW } },
      ctx(DEEP_KEEL),
      index,
      NOW
    );
    expect(straight.state).not.toBe("alarm");
    expect(turning.state).toBe("alarm");
    // The first footprint at alarm level is the rock; past it the turn runs on to a sounding.
    expect(turning.footprints.find((f) => f.risk >= 0.2)?.riskTile?.dMin).toBe(3.5);
  });

  test("a stale rate of turn is ignored", () => {
    const start = nav(ROCK[0] - 150 / M_PER_DEG_LON, ROCK[1] + 140 / 111320, EAST, 3);
    const old = { value: (1.2 * Math.PI) / 180, at: NOW - 60_000 };
    const r = evaluateLookahead({ ...start, rot: old }, ctx(DEEP_KEEL), index, NOW);
    expect(r.state).toBe(evaluateLookahead(start, ctx(DEEP_KEEL), index, NOW).state);
  });

  test("a wide GNSS fix grows the buffer until it reaches the rock", () => {
    // 120 m north of the rock heading east: k_p · σ_pos reaches it only with a poor fix.
    const beside = nav(westOfRock(30), ROCK[1] + 120 / 111320);
    const good = evaluateLookahead(
      { ...beside, hdop: { value: 0.8, at: NOW } },
      ctx(DEEP_KEEL),
      index,
      NOW
    );
    const poor = evaluateLookahead(
      { ...beside, hdop: { value: 15, at: NOW } },
      ctx(DEEP_KEEL),
      index,
      NOW
    );
    expect(good.risk as number).toBeLessThan(poor.risk as number);
    expect(poor.footprints[0]?.buffer).toBeCloseTo(2 * 15 * 3, 6);
    expect(good.footprints[0]?.buffer).toBe(DEFAULT_LOOKAHEAD.positionBuffer);
  });

  test("the escape heading turns away from the rock and clears it", () => {
    const head = nav(westOfRock(40), FAIRWAY_LAT);
    const r = evaluateLookahead(head, { ...ctx(DEEP_KEEL), escape: true }, index, NOW);
    expect(r.state).toBe("alarm");
    const escape = r.escapeHeading as number;
    expect(Math.abs(escape - EAST)).toBeGreaterThanOrEqual((5 * Math.PI) / 180 - 1e-9);
    expect(Math.abs(escape - EAST)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    const after = evaluateLookahead(
      nav(westOfRock(40), FAIRWAY_LAT, escape),
      ctx(DEEP_KEEL),
      index,
      NOW
    );
    expect(after.timeToShoal ?? Infinity).toBeGreaterThan(r.timeToShoal as number);
    // Without the flag, or in normal, no escape is searched.
    expect(evaluateLookahead(head, ctx(DEEP_KEEL), index, NOW).escapeHeading).toBeNull();
    const calm = evaluateLookahead(
      nav(22.003, FAIRWAY_LAT, EAST, 1),
      { ...ctx(DEEP_KEEL), escape: true },
      index,
      NOW
    );
    expect(calm.escapeHeading).toBeNull();
  });

  test("a long look-ahead at low speed stays bounded and leaves no gaps", () => {
    const opts = { ...DEFAULT_LOOKAHEAD, distance: 5 * 1852, minHorizon: 600 };
    const r = evaluateLookahead(
      nav(22.003, FAIRWAY_LAT, EAST, 0.3),
      ctx(DEEP_KEEL),
      index,
      NOW,
      opts
    );
    expect(r.footprints.length).toBeLessThanOrEqual(MAX_FOOTPRINTS);
    expect(r.horizon).toBeCloseTo((5 * 1852) / 0.3, 6);
    const reach = DEEP_KEEL.length + 2 * opts.positionBuffer;
    for (let i = 1; i < r.footprints.length; i++) {
      const dt = (r.footprints[i]?.t as number) - (r.footprints[i - 1]?.t as number);
      expect(dt * 0.3).toBeLessThanOrEqual(reach + 1e-9);
    }
    // A tiny hull with no buffer would need more steps: the horizon is cut instead.
    const dinghy = { draft: 1, length: 3, beam: 1.5 };
    const cut = evaluateLookahead(nav(22.003, FAIRWAY_LAT, EAST, 0.3), ctx(dinghy), index, NOW, {
      ...opts,
      positionBuffer: 0
    });
    expect(cut.footprints.length).toBeLessThanOrEqual(MAX_FOOTPRINTS);
    expect(cut.horizon).toBe(cut.footprints[cut.footprints.length - 1]?.t);
    expect(cut.horizon).toBeLessThan((5 * 1852) / 0.3);
  });

  test("a long look-ahead keeps the plan step inside the alarm and warn windows", () => {
    const rock: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: buildPyramid([...basin([22.0, 60.0, 22.04, 60.02], 10), point(22.02, 60.01, 1)], {
        minZoom: 12,
        leafZoom: 18
      }),
      hazards: new HazardIndex([])
    };
    const opts = { ...DEFAULT_LOOKAHEAD, distance: 5 * 1852 };
    // 70 m short of the rock at 0.3 m/s: alarm within 60 s. A 5 NM horizon in 400 equal steps
    // scored 0 s and then 77 s, and read it as a warn 77 s ahead.
    const r = evaluateLookahead(
      nav(22.02 - 70 / M_PER_DEG_LON, 60.01, EAST, 0.3),
      ctx(DEEP_KEEL),
      rock,
      NOW,
      opts
    );
    const within = r.footprints.filter((f) => f.t <= opts.warnWithin).map((f) => f.t);
    expect(within).toEqual(Array.from({ length: 41 }, (_, i) => i * opts.step));
    expect(r.state).toBe("alarm");
    expect(r.timeToShoal as number).toBeLessThan(opts.alarmWithin);
  });

  test("squat uses the faster of SOG and STW, even with COG stale", () => {
    const squatOf = (n: NavState) =>
      evaluateLookahead(n, ctx(DEEP_KEEL), index, NOW).worst?.explanation.squat;
    const base = nav(westOfRock(40), FAIRWAY_LAT, EAST, 2);
    // Barrass with Cb 0.4: 4 m/s = 7.78 kn → 0.24 m; 2 m/s → 0.06 m.
    expect(squatOf({ ...base, stw: { value: 4, at: NOW } })).toBeCloseTo(0.24, 2);
    expect(squatOf(base)).toBeCloseTo(0.06, 2);
    const noCog = { ...base, cog: { value: EAST, at: NOW - 60_000 } };
    expect(squatOf(noCog)).toBeCloseTo(0.06, 2);
    expect(squatOf({ ...noCog, sog: undefined, stw: { value: 4, at: NOW } })).toBeCloseTo(0.24, 2);
  });

  test("a rock under the bow never yields hold course as the escape", () => {
    const rock: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: buildPyramid([...basin([22.0, 60.0, 22.04, 60.02], 10), point(22.02, 60.01, 1)], {
        minZoom: 12,
        leafZoom: 18
      }),
      hazards: new HazardIndex([])
    };
    for (const d of [5, 15, 30]) {
      const r = evaluateLookahead(
        nav(22.02 - d / M_PER_DEG_LON, 60.01),
        { ...ctx(DEEP_KEEL), escape: true },
        rock,
        NOW
      );
      expect(r.state).toBe("alarm");
      if (r.escapeHeading !== null) {
        expect(Math.abs(r.escapeHeading - EAST)).toBeGreaterThanOrEqual((5 * Math.PI) / 180 - 1e-9);
      }
    }
  });

  test("a rock only the fan's spread reaches never yields hold course as the escape", () => {
    const rock: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: buildPyramid([...basin([22.0, 60.0, 22.04, 60.02], 10), point(22.02, 60.01, 1)], {
        minZoom: 12,
        leafZoom: 18
      }),
      hazards: new HazardIndex([])
    };
    // The rock is `ahead` m along the course and `off` m to port: a straight track passes it
    // clear, the COG + σ member does not. Scored on its track alone, holding course came out as
    // the escape in every state.
    const at = (ahead: number, off: number) =>
      evaluateLookahead(
        nav(22.02 - ahead / M_PER_DEG_LON, 60.01 - off / 111320),
        { ...ctx(DEEP_KEEL), escape: true },
        rock,
        NOW
      );
    for (const [ahead, off, state] of [
      [300, 30, "warn"],
      [400, 50, "warn"],
      [200, 30, "alarm"]
    ] as const) {
      const r = at(ahead, off);
      expect(r.state).toBe(state);
      // A turn to starboard, away from the rock.
      const turn = (r.escapeHeading as number) - EAST;
      expect(turn).toBeGreaterThanOrEqual((5 * Math.PI) / 180 - 1e-9);
      expect(turn).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    }
    // Held course stays clear of warn: no heading does better, so there is nothing to dodge to.
    const alert = at(300, 50);
    expect(alert.state).toBe("alert");
    expect(alert.escapeHeading).toBeNull();
  });

  test("an escape heading never counts water off the chart as clear", () => {
    // A deep basin whose east edge is 200 m ahead; the vessel runs east near its north side.
    const edge: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: buildPyramid(basin([22.0, 60.0, 22.02, 60.01], 10), { minZoom: 12, leafZoom: 18 }),
      hazards: new HazardIndex([])
    };
    const r = evaluateLookahead(
      nav(22.0165, 60.009, EAST, 3),
      { ...ctx(DEEP_KEEL), escape: true },
      edge,
      NOW
    );
    expect(r.state).toBe("warn");
    // Straight on leaves the chart; the escape turns south, back over charted water.
    const turn = (r.escapeHeading as number) - EAST;
    expect(turn).toBeGreaterThan(0);
    expect(turn).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
  });
});

describe("chart position uncertainty", () => {
  // A drying patch 60 m north of a stopped boat, about 50 m beyond its buffer:
  // it counts with P times Φ(−50/σP), about 42 % under C (σP 250 m), 2 to 11 %
  // under B (σP 25 m, a tile up to a leaf nearer), nothing under A1.
  const box = [22.0, 60.0, 22.06, 60.03] as const;
  const north = 60 / 111195;
  const chart = (catzoc: 1 | 3 | 4): ChartIndex => ({
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid(
      [
        coverage(box),
        quality(box, catzoc),
        area(box, 15),
        area([22.028, 60.015 + north, 22.032, 60.016 + north], -1)
      ],
      { minZoom: 12, leafZoom: 20 }
    ),
    hazards: new HazardIndex([])
  });
  test("a drying area 60 m off under CATZOC C alarms; the boat itself is over 15 m", () => {
    const r = evaluateLookahead(nav(22.03, 60.015, EAST, 0), ctx(SHALLOW_KEEL), chart(4), NOW);
    expect(r.state).toBe("alarm");
    expect(r.footprints[0]?.charted).toBe(15);
    expect(r.worst?.explanation.chartPosition?.source).toBe("survey");
  });

  test("under CATZOC B the same area raises the state by its smaller weight", () => {
    const r = evaluateLookahead(nav(22.03, 60.015, EAST, 0), ctx(SHALLOW_KEEL), chart(3), NOW);
    expect(r.state).not.toBe("normal");
    expect(r.state).not.toBe("alarm");
    expect(r.footprints[0]?.risk).toBeGreaterThan(0.02);
    expect(r.footprints[0]?.risk).toBeLessThan(0.12);
  });

  test("under CATZOC A1 (±5 m) the same area is out of reach", () => {
    const r = evaluateLookahead(nav(22.03, 60.015, EAST, 0), ctx(SHALLOW_KEEL), chart(1), NOW);
    expect(r.state).toBe("normal");
  });
});

describe("heel from roll", () => {
  // A 2.5 m bank everywhere: a 2.4 m fin keel is only clear when heeled.
  const bank: ChartIndex = {
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid(basin([22.0, 60.0, 22.04, 60.02], 2.5), { minZoom: 12, leafZoom: 18 }),
    hazards: new HazardIndex([])
  };
  const fin = { heel: { kind: "fin" as const } };
  const rolled = (roll: number, at = NOW): NavState => ({
    ...nav(22.02, 60.01),
    roll: { value: roll, at }
  });

  test("a roll beyond 60° never lifts the keel", () => {
    for (const draft of [2.4, 4, 8]) {
      const v = { ...DEEP_KEEL, draft };
      const upright = evaluateLookahead(nav(22.02, 60.01), ctx(v, CHART_DATUM, fin), bank, NOW);
      for (const roll of [1.2, 3, -3]) {
        const r = evaluateLookahead(rolled(roll), ctx(v, CHART_DATUM, fin), bank, NOW);
        expect(r.state).toBe("alarm");
        expect(r.risk).toBe(upright.risk);
      }
    }
  });

  test("a boat rolling through upright is scored at its least roll", () => {
    const n = navState();
    const h = new Hysteresis(DEFAULT_LOOKAHEAD);
    const v = { ...DEEP_KEEL, draft: 2.4 };
    const published = [];
    for (let tick = 0; tick < 6; tick++) {
      const now = NOW + tick * 1000;
      const at = { ...rolled(tick % 2 === 0 ? 0.7 : 0.05, now), rolls: n.rolls };
      for (const k of ["position", "cog", "sog", "heading"] as const) {
        (at[k] as { at: number }).at = now;
      }
      published.push(h.next(evaluateLookahead(at, ctx(v, CHART_DATUM, fin), bank, now)).state);
    }
    expect(published.slice(2)).toEqual(["alarm", "alarm", "alarm", "alarm"]);
  });
});
