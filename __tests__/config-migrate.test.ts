import fc from "fast-check";
import { parseConfig } from "../src/config";
import { CONFIG_VERSION, migrateConfig } from "../src/config-migrate";

/**
 * Version 1 configurations carry every look-ahead and squat default the old
 * form filled in. Migration drops those so the warning style and hull can
 * set them, and must not change what the plugin does with the configuration.
 */

const V1_FORM_DEFAULTS = {
  vessel: { draftSigma: 0.05, margin: 0, blockCoefficient: 0.4, confined: false, keel: "none" },
  lookahead: {
    distance: 555.6,
    minHorizon: 60,
    positionBuffer: 10,
    kp: 2,
    sigmaCog: 5,
    sigmaRot: 0.1,
    maxTurnRate: 3,
    alertRisk: 0.01,
    warnRisk: 0.05,
    alarmRisk: 0.2,
    warnWithin: 120,
    alarmWithin: 60,
    certainWithin: 30
  }
};

describe("configuration migration", () => {
  test("a version 1 form save loses the filled-in defaults and gains a version", () => {
    const m = migrateConfig({ cellsDir: "/c", ...V1_FORM_DEFAULTS });
    expect(m).toMatchObject({ from: 1, changed: true });
    expect(m.config.configVersion).toBe(CONFIG_VERSION);
    expect(m.dropped.sort()).toEqual(
      [
        "lookahead.alarmRisk",
        "lookahead.alarmWithin",
        "lookahead.alertRisk",
        "lookahead.certainWithin",
        "lookahead.distance",
        "lookahead.warnRisk",
        "lookahead.warnWithin",
        "vessel.blockCoefficient",
        "vessel.keel"
      ].sort()
    );
    expect(m.config.lookahead).toEqual({
      minHorizon: 60,
      positionBuffer: 10,
      kp: 2,
      sigmaCog: 5,
      sigmaRot: 0.1,
      maxTurnRate: 3
    });
  });

  test("a value the user changed stays", () => {
    const m = migrateConfig({ lookahead: { warnRisk: 0.03 }, vessel: { keel: "fin" } });
    expect(m.config).toMatchObject({ lookahead: { warnRisk: 0.03 }, vessel: { keel: "fin" } });
    expect(m.dropped).toEqual([]);
  });

  // Safety: the upgrade alone never changes a threshold, a window, squat or heel.
  test("parses to the same options before and after, for any version 1 configuration", () => {
    const pick = <T>(defaultValue: T, others: fc.Arbitrary<T>) =>
      fc.option(fc.oneof(fc.constant(defaultValue), others), { nil: undefined });
    const lookahead = fc.record({
      distance: pick(555.6, fc.double({ min: 0, max: 9260, noNaN: true })),
      alertRisk: pick(0.01, fc.double({ min: 1e-6, max: 1, noNaN: true })),
      warnRisk: pick(0.05, fc.double({ min: 1e-6, max: 1, noNaN: true })),
      alarmRisk: pick(0.2, fc.double({ min: 1e-6, max: 1, noNaN: true })),
      warnWithin: pick(120, fc.integer({ min: 0, max: 600 })),
      alarmWithin: pick(60, fc.integer({ min: 0, max: 600 })),
      certainWithin: pick(30, fc.integer({ min: 0, max: 600 }))
    });
    const vessel = fc.record({
      draft: fc.option(fc.double({ min: 0.5, max: 5, noNaN: true }), { nil: undefined }),
      blockCoefficient: pick(0.4, fc.double({ min: 0, max: 1, noNaN: true })),
      keel: pick("none", fc.constantFrom("fin", "table", "x"))
    });
    const mismatches: unknown[] = [];
    fc.assert(
      fc.property(lookahead, vessel, (l, v) => {
        const v1 = { lookahead: l, vessel: v };
        const before = parseConfig(v1);
        const after = parseConfig(migrateConfig(v1).config);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          mismatches.push(v1);
        }
      }),
      { numRuns: 300 }
    );
    expect(mismatches).toEqual([]);
  });

  test("a configuration naming a style or hull keeps its values", () => {
    const raw = {
      warningStyle: "late",
      lookahead: { warnRisk: 0.05 },
      vessel: { hull: "planing", keel: "none" }
    };
    expect(migrateConfig(raw).config).toMatchObject(raw);
  });

  test("version 2 and a newer version are left alone", () => {
    for (const configVersion of [CONFIG_VERSION, CONFIG_VERSION + 1]) {
      const raw = { configVersion, lookahead: { warnRisk: 0.05 } };
      const m = migrateConfig(raw);
      expect(m).toEqual({ config: raw, from: configVersion, changed: false, dropped: [] });
    }
  });

  test("migration is idempotent and leaves its input unchanged", () => {
    const raw = JSON.parse(JSON.stringify(V1_FORM_DEFAULTS)) as Record<string, unknown>;
    const once = migrateConfig(raw).config;
    expect(raw).toEqual(V1_FORM_DEFAULTS);
    expect(migrateConfig(once)).toMatchObject({ config: once, changed: false });
  });

  test("nothing saved migrates to an empty version 2 configuration", () => {
    for (const raw of [undefined, null, "x", []]) {
      expect(migrateConfig(raw).config).toEqual({ configVersion: CONFIG_VERSION });
    }
  });
});
