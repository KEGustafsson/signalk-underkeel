import { parseConfig } from "../src/config";
import type { WarningPreset } from "../src/config-presets";
import { WARNING_PRESETS } from "../src/config-presets";
import { DEFAULT_LOOKAHEAD } from "../src/engine/lookahead";

/**
 * The warning style sets the look-ahead fields the configuration leaves
 * empty. Balanced is the earlier default; an expert value overrides its
 * field alone.
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
