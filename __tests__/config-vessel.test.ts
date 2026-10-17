import { parseConfig, SCHEMA } from "../src/config";
import { DEFAULT_LOOKAHEAD } from "../src/engine/lookahead";
import { DEFAULT_DATUMS } from "../src/ingest/datum";
import { DEFAULT_DYNAMICS, FALLBACK_HULL, resolveVessel } from "../src/model/vessel";

describe("plugin configuration", () => {
  test("defaults when empty or malformed", () => {
    for (const raw of [undefined, null, {}, "x", { lookahead: 5, vessel: "y" }]) {
      const c = parseConfig(raw);
      expect(c.lookahead).toEqual(DEFAULT_LOOKAHEAD);
      expect(c.dynamics).toEqual(DEFAULT_DYNAMICS);
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
      vessel: { draft: 1.9, length: -3, beam: "4", margin: 0.2, blockCoefficient: 2, keel: "fin" },
      waterLevel: { source: "manual", height: -0.4, sigma: 0.05 },
      lookahead: { distance: -1, warnWithin: 20, alarmWithin: 45, alertRisk: 0.1, warnRisk: 0.02 },
      routeCheck: { probability: 0.9 }
    });
    expect(c.indexDir).toBe("/data/index");
    expect(c.cellsDir).toBeUndefined();
    expect(c.rebuildIndex).toBe(true);
    expect(c.leafZoom).toBe(20);
    expect(c.vessel).toEqual({ draft: 1.9, length: undefined, beam: undefined });
    expect(c.dynamics).toMatchObject({
      margin: 0.2,
      blockCoefficient: DEFAULT_DYNAMICS.blockCoefficient,
      heel: { kind: "fin" }
    });
    expect(c.waterLevel).toMatchObject({ source: "manual", height: -0.4, sigma: 0.05 });
    expect(c.lookahead.distance).toBe(DEFAULT_LOOKAHEAD.distance);
    // windows nest: warn is never narrower than alarm, certain never wider
    expect(c.lookahead.alarmWithin).toBe(45);
    expect(c.lookahead.warnWithin).toBe(45);
    expect(c.lookahead.certainWithin).toBe(30);
    // risk levels are ordered alert ≤ warn ≤ alarm
    expect(c.lookahead.thresholds).toEqual({ alert: 0.1, warn: 0.1, alarm: 0.2 });
    expect(c.routeCheck.probability).toBe(0.01);
  });

  test("water level defaults to no source and the default datum table", () => {
    expect(parseConfig({}).waterLevel).toEqual({
      source: "none",
      height: 0,
      sigma: 0.1,
      updateInterval: 600,
      datums: [...DEFAULT_DATUMS]
    });
    expect(parseConfig({ waterLevel: { source: "tide-tables" } }).waterLevel.source).toBe("none");
  });

  test("configured datum mappings replace the default for their code", () => {
    const { datums } = parseConfig({
      waterLevel: {
        datums: [
          { verdat: 26, series: "n2000", sigma: 0.02 },
          { verdat: 24, series: "n2000" },
          { verdat: 1.5, series: "mw" },
          { verdat: 7, series: "lat" }
        ]
      }
    }).waterLevel;
    expect(datums).toEqual([
      { verdat: 3, series: "mw", sigma: 0.1 },
      { verdat: 19, series: "mw", sigma: 0.1 },
      { verdat: 26, series: "n2000", sigma: 0.02 },
      { verdat: 24, series: "n2000", sigma: 0.05 }
    ]);
  });

  test("a heel table is read in degrees", () => {
    const c = parseConfig({
      vessel: { keel: "table", heelTable: [{ heel: 20, delta: 0.1 }, { heel: "x" }] }
    });
    expect(c.dynamics.heel).toEqual({
      kind: "table",
      points: [{ heel: (20 * Math.PI) / 180, delta: 0.1 }]
    });
    expect(parseConfig({ vessel: { keel: "table", heelTable: [] } }).dynamics.heel).toEqual({
      kind: "none"
    });
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
