import { parseConfig } from "../src/config";
import {
  adminSchema,
  flatten,
  formsFollowDependencies,
  SCHEMA,
  UI_SCHEMA
} from "../src/config-schema";

/**
 * The admin form: the essentials up front, expert settings and each
 * feature's fields behind a checkbox, the flat schema with all of them for
 * admin UIs that drop `dependencies`.
 */

type Schema = { properties?: Record<string, Schema>; [k: string]: unknown };

/** Field paths of a schema's own properties, not its dependencies. */
function fields(s: Schema, prefix = ""): string[] {
  return Object.entries(s.properties ?? {}).flatMap(([k, v]) =>
    v.type === "object" && v.properties ? fields(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

describe("admin form", () => {
  test("shows nine fields until expert settings or a feature are switched on", () => {
    expect(fields(adminSchema() as Schema)).toEqual([
      "cellsDir",
      "vessel.draft",
      "vessel.margin",
      "waterLevel.source",
      "warningStyle",
      "livechart.enabled",
      "wfs.enabled",
      "groundingDetector.enabled",
      "showExpert"
    ]);
  });

  test("the flat schema holds every setting once, without showExpert", () => {
    const all = fields(SCHEMA as Schema);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(56);
    expect(all).not.toContain("showExpert");
    for (const f of [
      "vessel.heelTable",
      "waterLevel.height",
      "waterLevel.datums",
      "livechart.sounderModel",
      "wfs.url",
      "groundingDetector.imuPath",
      "lookahead.certainWithin",
      "routeCheck.probability",
      "mooringZones",
      "leafZoom",
      "boxMaxRadiusKm"
    ]) {
      expect(all).toContain(f);
    }
  });

  test("flattening the flat schema changes nothing", () => {
    expect(flatten(SCHEMA)).toEqual(SCHEMA);
  });

  // The form fills a field's default into every save; a filled value would override the preset.
  test("the fields a warning style sets have no default", () => {
    const lookahead = (SCHEMA as Schema).properties?.lookahead?.properties ?? {};
    const preset = [
      lookahead.distance,
      lookahead.alertRisk,
      lookahead.warnRisk,
      lookahead.alarmRisk,
      lookahead.warnWithin,
      lookahead.alarmWithin,
      lookahead.certainWithin
    ];
    expect(preset.map((f) => f && "default" in f)).toEqual(preset.map(() => false));
  });

  // Safety: heel is the one term that lowers the draft, so it is off unless chosen.
  test("heel gives no credit unless set: the keel counts at full depth", () => {
    expect((SCHEMA as Schema).properties?.vessel?.properties?.keel).toMatchObject({
      default: "none"
    });
    expect(parseConfig({}).dynamics.heel).toEqual({ kind: "none" });
  });

  test("the warning style is a radio choice defaulting to balanced", () => {
    expect((SCHEMA as Schema).properties?.warningStyle).toMatchObject({ default: "balanced" });
    expect(UI_SCHEMA.warningStyle["ui:widget"]).toBe("radio");
  });

  test("setup hints go in the description, the draft and the water-level source", () => {
    const s = adminSchema({
      checks: ["✓ Charts: 3 cells indexed", "✗ Draft: not set"],
      signalkDraft: 2.2,
      source:
        "Your charts are not on low water (VERDAT 3 in 3 cells): choose fmi in Finnish waters."
    }) as Schema;
    expect(s.description).toMatch(/^Advisory .*Not for navigation.*Setup check: ✓ Charts.*✗ Draft/);
    expect(s.properties?.vessel?.properties?.draft?.description).toMatch(/: 2\.2 m\./);
    expect(s.properties?.waterLevel?.properties?.source?.description).toMatch(
      /^Your charts are not on low water.*none: chart datum/
    );
  });
});

describe("admin UI version", () => {
  test.each([
    ["2.32.0", true],
    ["2.40.1-beta.2", true],
    ["3.0.0", true],
    ["2.31.9", false],
    ["1.46.3", false],
    [undefined, false],
    ["master", false]
  ])("%s forwards dependencies: %s", (version, expected) => {
    expect(formsFollowDependencies(version)).toBe(expected);
  });
});
