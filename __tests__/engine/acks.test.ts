import type { Ack, SuppressionContext } from "../../src/engine/acks";
import { ACK_LEVEL_TOLERANCE, suppress } from "../../src/engine/acks";
import type { FootprintResult, LookaheadResult } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import type { LonLat } from "../../src/foundation/geo";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const EAST = Math.PI / 2;

const box = (w: number, s: number, e: number, n: number): LonLat[] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n]
];

function fp(t: number, ring: LonLat[], risk: number, mean = 1): FootprintResult {
  return {
    t,
    center: ring[0] as LonLat,
    ring,
    buffer: 10,
    charted: 3,
    mean,
    sigma: 0.5,
    risk,
    uncovered: false,
    flags: 0,
    sigmaP: 2.5
  };
}

function result(state: LookaheadResult["state"], fps: FootprintResult[]): LookaheadResult {
  return {
    state,
    reason: "shoal ahead in 40 s",
    clearance: 1,
    clearanceSigma: 0.5,
    risk: Math.max(...fps.map((f) => f.risk)),
    timeToShoal: 40,
    escapeHeading: 0.3,
    horizon: 60,
    footprints: fps
  };
}

const PASSAGE = box(22.0, 60.0, 22.01, 60.005);
const WARN = result("warn", [
  fp(0, box(22.001, 60.002, 22.0012, 60.0021), 0),
  fp(30, box(22.004, 60.002, 22.0042, 60.0021), 0.08),
  fp(60, box(22.02, 60.002, 22.0202, 60.0021), 0)
]);

const ACK: Ack = {
  id: "a1",
  created: new Date(NOW - 3600_000).toISOString(),
  polygon: PASSAGE,
  heading: EAST,
  sector: (20 * Math.PI) / 180,
  waterLevel: 0.2,
  draft: 1.8
};

const LEVEL = { h: 0.2, sigma: 0.05, source: "manual" };

function ctx(over: Partial<SuppressionContext> = {}): SuppressionContext {
  return {
    acks: [ACK],
    zones: [],
    heading: EAST,
    waterLevel: LEVEL,
    draft: 1.8,
    now: NOW,
    thresholds: DEFAULT_LOOKAHEAD.thresholds,
    certainWithin: DEFAULT_LOOKAHEAD.certainWithin,
    ...over
  };
}

describe("acknowledged passages", () => {
  test("a warn whose risky footprints lie in an acknowledged passage becomes an alert with the reason", () => {
    expect(suppress(WARN, ctx())).toMatchObject({
      state: "alert",
      reason: "acknowledged passage: shoal ahead in 40 s"
    });
  });

  test("each condition of plan §4.12 must hold", () => {
    const cases: Partial<SuppressionContext>[] = [
      { heading: EAST + (25 * Math.PI) / 180 },
      { waterLevel: { ...LEVEL, h: 0.2 - ACK_LEVEL_TOLERANCE - 0.01 } },
      { draft: 1.9 },
      { now: NOW, acks: [{ ...ACK, expires: new Date(NOW - 1).toISOString() }] },
      { acks: [{ ...ACK, polygon: box(22.0, 60.0, 22.003, 60.005) }] }
    ];
    for (const c of cases) {
      expect(suppress(WARN, ctx(c)).state).toBe("warn");
    }
    expect(
      suppress(WARN, ctx({ waterLevel: { ...LEVEL, h: 0.2 - ACK_LEVEL_TOLERANCE + 0.01 } })).state
    ).toBe("alert");
    expect(suppress(WARN, ctx({ heading: EAST - (19 * Math.PI) / 180, draft: 1.5 })).state).toBe(
      "alert"
    );
  });

  test("a fallback water level never honours an acknowledgement", () => {
    // The chart-datum fallback is 0 m with a reason; even at the acknowledged level it is a guess.
    const fallback = { h: 0.2, sigma: 0.3, source: "fallback", degraded: "tide feed stale" };
    expect(suppress(WARN, ctx({ waterLevel: fallback })).state).toBe("warn");
  });

  test("the heading sector wraps through north", () => {
    const north = { ...ACK, heading: (355 * Math.PI) / 180 };
    expect(suppress(WARN, ctx({ acks: [north], heading: (10 * Math.PI) / 180 })).state).toBe(
      "alert"
    );
  });

  test("a negative mean UKC within the certain window is never suppressed", () => {
    const certain = result("alarm", [fp(0, box(22.001, 60.002, 22.0012, 60.0021), 0.6, -0.2)]);
    expect(suppress(certain, ctx()).state).toBe("alarm");
  });

  test("normal and alert pass unchanged, and nothing becomes normal", () => {
    for (const state of ["normal", "alert", "unknown", "off"] as const) {
      expect(suppress({ ...WARN, state }, ctx()).state).toBe(state);
    }
  });

  test("a footprint edge that leaves a concave passage between its vertices is not covered", () => {
    // A U-shaped passage open to the north; the footprint's ends sit in both arms.
    const u: LonLat[] = [
      [22.0, 60.0],
      [22.01, 60.0],
      [22.01, 60.005],
      [22.006, 60.005],
      [22.006, 60.001],
      [22.004, 60.001],
      [22.004, 60.005],
      [22.0, 60.005]
    ];
    const across = result("warn", [fp(30, box(22.003, 60.002, 22.007, 60.0021), 0.08)]);
    expect(suppress(across, ctx({ acks: [{ ...ACK, polygon: u }] })).state).toBe("warn");
    const inArm = result("warn", [fp(30, box(22.001, 60.002, 22.003, 60.0021), 0.08)]);
    expect(suppress(inArm, ctx({ acks: [{ ...ACK, polygon: u }] })).state).toBe("alert");
  });

  test("a pocket reached only through vertices on a footprint edge is not covered", () => {
    // In thousandths of a degree from 22 E, 60 N: a passage whose notch walls end at
    // vertices lying exactly on the footprint's north edge, so no edge crosses a wall.
    const at = (x: number, y: number): LonLat => [22 + x / 1000, 60 + y / 1000];
    const notched = [
      at(0, -2),
      at(8, -2),
      at(8, 2),
      at(4.11, 2),
      at(4.11, 0),
      at(4.6, -1),
      at(3.5, -1),
      at(4.01, 0),
      at(4.01, 2),
      at(0, 2)
    ];
    const ring = [at(0.5, 0), at(7.5, 0), at(7.5, -1.5), at(0.5, -1.5)];
    const r = result("warn", [fp(30, ring, 0.08)]);
    expect(suppress(r, ctx({ acks: [{ ...ACK, polygon: notched }] })).state).toBe("warn");
    // The same footprint in a passage without the notch is covered, its edge on the boundary.
    const plain = [at(0, -2), at(8, -2), at(8, 0), at(0, 0)];
    expect(suppress(r, ctx({ acks: [{ ...ACK, polygon: plain }] })).state).toBe("alert");
  });

  test("a mooring zone suppresses the same way and names the zone", () => {
    const zones = [{ name: "home berth", polygon: PASSAGE, holes: [] }];
    const r = suppress(WARN, ctx({ acks: [], zones }));
    expect(r).toMatchObject({
      state: "alert",
      reason: "in mooring zone home berth: shoal ahead in 40 s"
    });
  });

  test("a footprint touching a hole cut out of a mooring zone is outside the zone", () => {
    // The risky footprint is box(22.004, 60.002, 22.0042, 60.0021).
    const zone = (hole: LonLat[]) => ({ name: "berth", polygon: PASSAGE, holes: [hole] });
    const state = (hole: LonLat[]) => suppress(WARN, ctx({ acks: [], zones: [zone(hole)] })).state;
    // The footprint inside the hole, the hole inside the footprint, the two crossing, the same.
    expect(state(box(22.003, 60.001, 22.005, 60.003))).toBe("warn");
    expect(state(box(22.0041, 60.00202, 22.0042, 60.00205))).toBe("warn");
    expect(state(box(22.0041, 60.0015, 22.0045, 60.0025))).toBe("warn");
    expect(state(box(22.004, 60.002, 22.0042, 60.0021))).toBe("warn");
    // A hole elsewhere, or only sharing the footprint's edge, leaves it in the zone.
    expect(state(box(22.008, 60.001, 22.009, 60.002))).toBe("alert");
    expect(state(box(22.0042, 60.002, 22.005, 60.0021))).toBe("alert");
  });
});
