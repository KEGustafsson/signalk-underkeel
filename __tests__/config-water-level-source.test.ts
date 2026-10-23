import { parseConfig, SCHEMA } from "../src/config";

/**
 * The water-level source is chosen by the user, never automatically (plan
 * §10): `none` stays the default and no "auto" source exists. The setting's
 * title matches the hint the no-source reason gives ("set Water level source
 * to …").
 */

describe("water-level source setting", () => {
  const source = (
    SCHEMA.properties as unknown as Record<string, { properties: Record<string, unknown> }>
  ).waterLevel?.properties.source as Record<string, unknown> | undefined;

  test("is titled Source under Water level, defaults to none and offers no automatic choice", () => {
    expect(source).toMatchObject({ title: "Source", default: "none" });
    expect(source?.enum).toEqual(["none", "manual", "signalk-tide", "fmi"]);
    expect(parseConfig({}).waterLevel.source).toBe("none");
  });

  test("says that none is a guess on charts whose datum is not low water", () => {
    expect(source?.description).toMatch(/not low water.*never normal; choose fmi there/);
  });
});
