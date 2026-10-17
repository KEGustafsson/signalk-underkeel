import { Hysteresis } from "../../src/engine/hysteresis";
import type { LookaheadResult } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import type { UnderKeelState } from "../../src/foundation/state";

const TH = DEFAULT_LOOKAHEAD.thresholds;

function raw(state: UnderKeelState, risk: number | null, reason = state): LookaheadResult {
  return {
    state,
    reason,
    clearance: 1,
    clearanceSigma: 0.3,
    risk,
    timeToShoal: null,
    escapeHeading: state === "normal" ? null : 1,
    horizon: 60,
    footprints: []
  };
}

function run(h: Hysteresis, inputs: LookaheadResult[]): UnderKeelState[] {
  return inputs.map((r) => h.next(r).state);
}

describe("state hysteresis", () => {
  test("a raise needs two consecutive ticks", () => {
    const h = new Hysteresis(TH);
    expect(
      run(h, [
        raw("normal", 0),
        raw("warn", 0.1),
        raw("normal", 0),
        raw("warn", 0.1),
        raw("warn", 0.1)
      ])
    ).toEqual(["normal", "normal", "normal", "normal", "warn"]);
  });

  test("a lower needs five ticks below the threshold less 20 %", () => {
    const h = new Hysteresis(TH);
    run(h, [raw("normal", 0), raw("warn", 0.1), raw("warn", 0.1)]);
    // 0.045 is under warn (0.05) but above 0.8 × warn: held.
    expect(
      run(
        h,
        Array.from({ length: 8 }, () => raw("alert", 0.045))
      )
    ).toEqual(Array.from({ length: 8 }, () => "warn"));
    expect(
      run(
        h,
        Array.from({ length: 5 }, () => raw("alert", 0.02))
      )
    ).toEqual(["warn", "warn", "warn", "warn", "alert"]);
  });

  test("a held state keeps its reason and the current numbers", () => {
    const h = new Hysteresis(TH);
    run(h, [
      raw("normal", 0),
      raw("alarm", 0.5, "shoal ahead in 20 s"),
      raw("alarm", 0.5, "shoal ahead in 20 s")
    ]);
    const out = h.next({ ...raw("normal", 0.001, ""), clearance: 3 });
    expect(out).toMatchObject({
      state: "alarm",
      reason: "shoal ahead in 20 s",
      clearance: 3,
      escapeHeading: 1
    });
  });

  test("unknown and off pass through at once and are left at once", () => {
    const h = new Hysteresis(TH);
    expect(
      run(h, [
        raw("alarm", 0.5),
        raw("unknown", null),
        raw("alarm", 0.5),
        raw("off", null),
        raw("normal", 0)
      ])
    ).toEqual(["alarm", "unknown", "alarm", "off", "normal"]);
  });

  test("a raise interrupted by a lower state starts counting again", () => {
    const h = new Hysteresis(TH);
    expect(
      run(h, [
        raw("alert", 0.02),
        raw("alarm", 0.3),
        raw("alert", 0.02),
        raw("alarm", 0.3),
        raw("alarm", 0.3)
      ])
    ).toEqual(["alert", "alert", "alert", "alert", "alarm"]);
  });
});
