import { parseConfig } from "../src/config";
import type { WarningPreset } from "../src/config-presets";
import { HULL_PRESETS, HULLS, WARNING_PRESETS } from "../src/config-presets";
import { DEFAULT_LOOKAHEAD } from "../src/engine/lookahead";
import { DEFAULT_DYNAMICS } from "../src/model/vessel";

/**
 * The warning style and the hull set the expert fields the configuration
 * leaves empty. Balanced and no hull are the earlier defaults; an expert
 * value overrides its preset field alone.
 */

describe("warning style", () => {
  test("balanced, unset or unknown is the earlier look-ahead default", () => {
    for (const warningStyle of [undefined, "balanced", "loud", 3]) {
      expect(parseConfig({ warningStyle }).lookahead).toEqual(DEFAULT_LOOKAHEAD);
    }
  });

  // Safety: a more cautious style may never warn later or less often in any field.
  test("early is at least as cautious as balanced, and balanced as late, field by field", () => {
    const cautious = (a: WarningPreset, b: WarningPreset) => ({
      distance: a.distance >= b.distance,
      alertRisk: a.alertRisk <= b.alertRisk,
      warnRisk: a.warnRisk <= b.warnRisk,
      alarmRisk: a.alarmRisk <= b.alarmRisk,
      warnWithin: a.warnWithin >= b.warnWithin,
      alarmWithin: a.alarmWithin >= b.alarmWithin,
      certainWithin: a.certainWithin >= b.certainWithin
    });
    const allTrue = Object.fromEntries(Object.keys(WARNING_PRESETS.balanced).map((k) => [k, true]));
    expect(cautious(WARNING_PRESETS.early, WARNING_PRESETS.balanced)).toEqual(allTrue);
    expect(cautious(WARNING_PRESETS.balanced, WARNING_PRESETS.late)).toEqual(allTrue);
  });

  test("every style keeps the 30 s alarm on a negative mean clearance", () => {
    expect(Object.values(WARNING_PRESETS).map((p) => p.certainWithin)).toEqual([30, 30, 30]);
  });

  test("a style sets the thresholds, windows and distance", () => {
    const early = parseConfig({ warningStyle: "early" }).lookahead;
    expect(early).toMatchObject({
      distance: 926,
      thresholds: { alert: 0.005, warn: 0.02, alarm: 0.1 },
      warnWithin: 180,
      alarmWithin: 90,
      certainWithin: 30
    });
    const late = parseConfig({ warningStyle: "late" }).lookahead;
    expect(late).toMatchObject({
      thresholds: { alert: 0.02, warn: 0.1, alarm: 0.3 },
      warnWithin: 90,
      alarmWithin: 45,
      certainWithin: 30
    });
    expect(late.distance).toBeCloseTo(0.2 * 1852, 9);
    // Geometry stays where it was.
    expect(early.kp).toBe(DEFAULT_LOOKAHEAD.kp);
  });

  test("an expert value overrides its field and the others follow the style", () => {
    const l = parseConfig({ warningStyle: "late", lookahead: { warnRisk: 0.04 } }).lookahead;
    expect(l.thresholds).toEqual({ alert: 0.02, warn: 0.04, alarm: 0.3 });
  });
});

describe("hull", () => {
  test("not set, unknown or 'none' keeps squat Cb 0.4 and ignores heel", () => {
    for (const hull of [undefined, "none", "raft"]) {
      const c = parseConfig({ vessel: { hull } });
      expect(c.dynamics).toEqual(DEFAULT_DYNAMICS);
      expect(c.hull).toBeUndefined();
    }
  });

  test.each(HULLS)("%s sets the block coefficient and the heel model", (hull) => {
    const c = parseConfig({ vessel: { hull } });
    expect(c.hull).toBe(hull);
    expect(c.dynamics.blockCoefficient).toBe(HULL_PRESETS[hull].blockCoefficient);
    expect(c.dynamics.heel).toEqual({ kind: HULL_PRESETS[hull].keel });
  });

  test("only a fin keel lifts the keel with heel", () => {
    expect(HULLS.filter((h) => HULL_PRESETS[h].keel === "fin")).toEqual(["finKeel"]);
  });

  test("expert block coefficient and keel override the hull", () => {
    const c = parseConfig({ vessel: { hull: "finKeel", blockCoefficient: 0.7, keel: "none" } });
    expect(c.dynamics).toMatchObject({ blockCoefficient: 0.7, heel: { kind: "none" } });
  });
});
