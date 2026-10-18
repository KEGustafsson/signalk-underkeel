import { parseConfig, SCHEMA } from "../src/config";
import { DEFAULT_LOOKAHEAD } from "../src/engine/lookahead";
import { FALLBACK_HULL, resolveVessel } from "../src/model/vessel";

describe("plugin configuration", () => {
  test("defaults when empty or malformed", () => {
    for (const raw of [undefined, null, {}, "x", { lookahead: 5, vessel: "y" }]) {
      const c = parseConfig(raw);
      expect(c.lookahead).toEqual(DEFAULT_LOOKAHEAD);
      expect(c.vessel).toEqual({ draft: undefined, length: undefined, beam: undefined });
      expect(c.leafZoom).toBe(20);
      expect(c.rebuildIndex).toBe(false);
      expect(c.indexDir).toBeUndefined();
    }
  });

  test("reads valid values and rejects out-of-range ones", () => {
    const c = parseConfig({
      indexDir: "/data/index",
      cellsDir: " ",
      rebuildIndex: true,
      leafZoom: 30,
      vessel: { draft: 1.9, length: -3, beam: "4" },
      lookahead: { margin: 0.8, distance: -1, warnWithin: 20, alarmWithin: 45 }
    });
    expect(c.indexDir).toBe("/data/index");
    expect(c.cellsDir).toBeUndefined();
    expect(c.rebuildIndex).toBe(true);
    expect(c.leafZoom).toBe(20);
    expect(c.vessel).toEqual({ draft: 1.9, length: undefined, beam: undefined });
    expect(c.lookahead.margin).toBe(0.8);
    expect(c.lookahead.distance).toBe(DEFAULT_LOOKAHEAD.distance);
    // warn is never narrower than alarm
    expect(c.lookahead.alarmWithin).toBe(45);
    expect(c.lookahead.warnWithin).toBe(45);
  });

  test("the schema carries the advisory disclaimer", () => {
    expect(SCHEMA.description).toMatch(/Not for navigation/);
  });
});

describe("vessel model", () => {
  test("configuration overrides Signal K", () => {
    const r = resolveVessel({
      config: { draft: 2.1 },
      signalk: { draft: 1.8, length: 11, beam: 3.6 }
    });
    expect(r.vessel).toEqual({ draft: 2.1, length: 11, beam: 3.6 });
    expect(r.notes).toEqual([]);
  });

  test("missing hull size falls back with a note; missing draft gives no vessel", () => {
    const r = resolveVessel({ config: {}, signalk: { draft: 1.5 } });
    expect(r.vessel).toEqual({ draft: 1.5, ...FALLBACK_HULL });
    expect(r.notes).toHaveLength(2);
    const none = resolveVessel({ config: { draft: 0 }, signalk: { draft: NaN } });
    expect(none.vessel).toBeUndefined();
    expect(none.notes[0]).toBe("vessel draft not configured");
  });
});
