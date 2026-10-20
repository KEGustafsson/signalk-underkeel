import { Hysteresis } from "../../src/engine/hysteresis";
import type { FootprintResult, LookaheadResult } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import type { UnderKeelState } from "../../src/foundation/state";

const TH = DEFAULT_LOOKAHEAD;

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

  test("unknown and off pass through at once; after them a held state lowers as usual", () => {
    const h = new Hysteresis(TH);
    expect(
      run(h, [
        raw("alarm", 0.5),
        raw("unknown", null),
        raw("alarm", 0.5),
        raw("off", null),
        raw("normal", 0)
      ])
    ).toEqual(["alarm", "unknown", "alarm", "off", "alarm"]);
    expect(h.next(raw("normal", 0)).reason).toBe("alarm");
    expect(
      run(
        h,
        Array.from({ length: 3 }, () => raw("normal", 0))
      )
    ).toEqual(["alarm", "alarm", "normal"]);
  });

  test("leaving unknown into a higher state raises at once", () => {
    const h = new Hysteresis(TH);
    expect(run(h, [raw("normal", 0), raw("unknown", null), raw("alarm", 0.5)])).toEqual([
      "normal",
      "unknown",
      "alarm"
    ]);
  });

  test("risk beyond the held state's time window does not hold it", () => {
    const fp = (t: number, risk: number) => ({ t, risk }) as FootprintResult;
    const at = (state: UnderKeelState, reason: string, far: number): LookaheadResult => ({
      ...raw(state, 0.9, reason),
      footprints: [fp(0, 0), fp(40, state === "alarm" ? 0.9 : 0), fp(150, far)]
    });
    const h = new Hysteresis(TH);
    run(h, [at("alarm", "shoal ahead in 40 s", 0.9), at("alarm", "shoal ahead in 40 s", 0.9)]);
    // The vessel slowed: the shoal is 150 s ahead, beyond the 60 s alarm window.
    const out = Array.from({ length: 5 }, () => h.next(at("alert", "shoal risk in 150 s", 0.9)));
    expect(out.map((o) => o.state)).toEqual(["alarm", "alarm", "alarm", "alarm", "alert"]);
    expect(out.map((o) => o.reason)).toEqual([
      ...Array.from({ length: 4 }, () => "shoal ahead in 40 s"),
      "shoal risk in 150 s"
    ]);
    // Risk inside the window still holds the state.
    const held = new Hysteresis(TH);
    run(held, [at("alarm", "a", 0.9), at("alarm", "a", 0.9)]);
    const near = { ...at("warn", "b", 0), footprints: [fp(0, 0), fp(50, 0.18)] };
    expect(
      run(
        held,
        Array.from({ length: 8 }, () => near)
      )
    ).toEqual(Array.from({ length: 8 }, () => "alarm"));
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
