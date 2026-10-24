import type { CellInfo } from "../../src/ingest/cells";
import { datumUses, DEFAULT_DATUMS, UNKNOWN_DATUM_SIGMA } from "../../src/ingest/datum";
import type { LevelSample, WaterLevelProvider } from "../../src/model/water-level";
import {
  CHART_DATUM,
  CHART_DATUM_SIGMA,
  lowestWaterLevel,
  manualProvider,
  resolveWaterLevel,
  SignalKTideProvider,
  STALE_AFTER_MS
} from "../../src/model/water-level";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3600 * 1000;

function cell(name: string, sdat?: number, vdat?: number): CellInfo {
  return { name, edition: 1, update: 0, band: 5, soundingDatum: sdat, verticalDatum: vdat };
}

/** A series provider whose level depends on the series and falls 0.1 m an hour. */
function seriesProvider(lastUpdate: number | undefined, ok = true): WaterLevelProvider {
  return {
    id: "stub",
    reference: "series",
    levelAt: (_p, t, series): LevelSample | undefined =>
      t > NOW + 48 * HOUR
        ? undefined
        : {
            h: (series === "mw" ? 0.4 : 0.6) - (0.1 * (t - NOW)) / HOUR,
            sigma: 0.05,
            source: "stub"
          },
    health: () => (ok ? { ok, lastUpdate } : { ok, message: "feed down" })
  };
}

describe("chart datum mapping", () => {
  test("cells group by VERDAT code, the sounding datum first", () => {
    const uses = datumUses([cell("A", 26, 3), cell("B", undefined, 26), cell("C", 3)]);
    expect(uses).toEqual([
      { series: "mw", sigma: 0.1, verdat: 26, known: true, cells: ["A", "B"] },
      { series: "mw", sigma: 0.1, verdat: 3, known: true, cells: ["C"] }
    ]);
  });

  test("an unmapped or missing datum is unknown with σ 0.5 m", () => {
    const uses = datumUses([cell("A", 13), cell("B")], DEFAULT_DATUMS);
    expect(uses.map((u) => [u.verdat, u.known, u.sigma])).toEqual([
      [13, false, UNKNOWN_DATUM_SIGMA],
      [undefined, false, UNKNOWN_DATUM_SIGMA]
    ]);
  });

  test("a cell with datum areas on another VERDAT is unknown and names them", () => {
    const mixed: CellInfo = { ...cell("MIX", 3), datumAreas: [24] };
    const uses = datumUses([cell("A", 3), mixed]);
    expect(uses).toEqual([
      { series: "mw", sigma: 0.1, verdat: 3, known: true, cells: ["A"] },
      {
        series: "mw",
        sigma: UNKNOWN_DATUM_SIGMA,
        verdat: 3,
        known: false,
        datumAreas: [24],
        cells: ["MIX"]
      }
    ]);
  });
});

describe("water-level resolution", () => {
  const n2000 = datumUses([cell("N", 24)], [{ verdat: 24, series: "n2000", sigma: 0.02 }]);

  test("no provider on low-water datums is chart datum with σ 0.3 m and no fallback reason", () => {
    expect(resolveWaterLevel(undefined, [], undefined, NOW, NOW)).toEqual(CHART_DATUM);
    const low = datumUses([cell("LAT", 23), cell("MLLW", 12), cell("WFS")]);
    expect(resolveWaterLevel(undefined, low, undefined, NOW, NOW)).toEqual(CHART_DATUM);
    expect(CHART_DATUM.sigma).toBe(CHART_DATUM_SIGMA);
  });

  test("no provider on a datum that is not low water is degraded and names it", () => {
    // Finnish cells on mean water: the Baltic is often 0.3-0.8 m below it.
    const uses = datumUses([cell("LAT", 23), cell("FI", 3), cell("FI2", 26)]);
    expect(resolveWaterLevel(undefined, uses, undefined, NOW, NOW)).toEqual({
      ...CHART_DATUM,
      degraded:
        "no water-level source: chart datum assumed, which is not low water (VERDAT 3, VERDAT 26)"
    });
    const mixed = datumUses([{ ...cell("MIX", 12), datumAreas: [3] }]);
    expect(resolveWaterLevel(undefined, mixed, undefined, NOW, NOW).degraded).toMatch(
      /\(VERDAT 3\)$/
    );
    const leg = lowestWaterLevel(undefined, uses, undefined, NOW, NOW + HOUR, NOW);
    expect(leg).toMatchObject({ h: 0, sigma: CHART_DATUM_SIGMA });
    expect(leg.degraded).toMatch(/no water-level source/);
  });

  test("a manual height is applied as set", () => {
    expect(resolveWaterLevel(manualProvider(-0.3, 0.05), [], undefined, NOW, NOW)).toEqual({
      h: -0.3,
      sigma: 0.05,
      source: "manual"
    });
  });

  test("a series level adds the datum match σ", () => {
    const wl = resolveWaterLevel(seriesProvider(NOW), n2000, undefined, NOW, NOW);
    expect(wl.h).toBeCloseTo(0.6, 9);
    expect(wl.sigma).toBeCloseTo(Math.hypot(0.05, 0.02), 9);
    expect(wl.degraded).toBeUndefined();
  });

  test("cells on different datums take the lowest level and the widest σ", () => {
    const uses = [...n2000, ...datumUses([cell("M", 26)])];
    const wl = resolveWaterLevel(seriesProvider(NOW), uses, undefined, NOW, NOW);
    expect(wl.h).toBeCloseTo(0.4, 9);
    expect(wl.sigma).toBeCloseTo(Math.hypot(0.05, 0.1), 9);
  });

  test("an unknown datum widens σ to at least 0.5 m and says which cells", () => {
    const uses = [...n2000, ...datumUses([cell("OLD", 13)])];
    const wl = resolveWaterLevel(seriesProvider(NOW), uses, undefined, NOW, NOW);
    expect(wl.sigma).toBeGreaterThanOrEqual(UNKNOWN_DATUM_SIGMA);
    expect(wl.note).toBe("vertical datum unknown for OLD");
    expect(wl.degraded).toBeUndefined();
  });

  test("a feed older than 30 minutes falls back to chart datum with a reason", () => {
    const fresh = resolveWaterLevel(
      seriesProvider(NOW - STALE_AFTER_MS),
      n2000,
      undefined,
      NOW,
      NOW
    );
    expect(fresh.degraded).toBeUndefined();
    const stale = resolveWaterLevel(seriesProvider(NOW - 31 * 60000), n2000, undefined, NOW, NOW);
    expect(stale).toEqual({
      h: 0,
      sigma: CHART_DATUM_SIGMA,
      source: "fallback",
      degraded: "water level from stub is 31 min old"
    });
  });

  test("a stale feed below chart datum falls back to its last level, not to chart datum", () => {
    const last = NOW + 10 * HOUR;
    const stale = last + 31 * 60000;
    expect(resolveWaterLevel(seriesProvider(last), n2000, undefined, stale, stale)).toEqual({
      h: expect.closeTo(-0.4, 9) as number,
      sigma: CHART_DATUM_SIGMA,
      source: "fallback",
      degraded: "water level from stub is 31 min old"
    });
  });

  test("a time past the data falls back to the last level when that is below chart datum", () => {
    const low: WaterLevelProvider = {
      id: "low",
      reference: "chart",
      levelAt: (_p, t) => (t <= NOW ? { h: -0.25, sigma: 0.05, source: "low" } : undefined),
      health: () => ({ ok: true, lastUpdate: NOW })
    };
    const wl = resolveWaterLevel(low, [], undefined, NOW + HOUR, NOW);
    expect(wl).toMatchObject({ h: -0.25, sigma: CHART_DATUM_SIGMA, source: "fallback" });
    expect(wl.degraded).toMatch(/no value/);
  });

  test("an unhealthy or empty feed falls back with its message", () => {
    const down = resolveWaterLevel(seriesProvider(NOW, false), n2000, undefined, NOW, NOW);
    expect(down.degraded).toBe("water level from stub: feed down");
    const never = resolveWaterLevel(seriesProvider(undefined), n2000, undefined, NOW, NOW);
    expect(never.degraded).toBe("water level from stub: no data");
  });

  test("a time past the forecast falls back", () => {
    const wl = resolveWaterLevel(seriesProvider(NOW), n2000, undefined, NOW + 49 * HOUR, NOW);
    expect(wl.degraded).toMatch(/no n2000 value/);
  });

  test("over an interval the lowest level applies", () => {
    const wl = lowestWaterLevel(seriesProvider(NOW), n2000, undefined, NOW, NOW + 3 * HOUR, NOW);
    expect(wl.h).toBeCloseTo(0.3, 9);
    expect(wl.degraded).toBeUndefined();
    const past = lowestWaterLevel(seriesProvider(NOW), n2000, undefined, NOW, NOW + 50 * HOUR, NOW);
    expect(past.degraded).toBeDefined();
  });

  test("a fallback inside an interval keeps the lower level found before it", () => {
    // The forecast reaches -4.2 m at 48 h and ends; the fallback is chart datum.
    const wl = lowestWaterLevel(
      seriesProvider(NOW),
      n2000,
      undefined,
      NOW + 40 * HOUR,
      NOW + 50 * HOUR,
      NOW
    );
    expect(wl.h).toBeCloseTo(-4.2, 9);
    expect(wl.sigma).toBe(CHART_DATUM_SIGMA);
    expect(wl.source).toBe("fallback");
    expect(wl.degraded).toMatch(/no n2000 value/);
  });
});

describe("Signal K tide provider", () => {
  test("reports nothing until environment.tide.heightNow arrives", () => {
    const p = new SignalKTideProvider(0.1);
    expect(resolveWaterLevel(p, [], undefined, NOW, NOW).degraded).toMatch(/heightNow/);
    expect(p.record("navigation.position", {}, NOW)).toBe(false);
    expect(p.record("environment.tide.heightNow", 0.42, NOW)).toBe(true);
    expect(resolveWaterLevel(p, [], undefined, NOW, NOW)).toEqual({
      h: 0.42,
      sigma: 0.1,
      source: "signalk-tide"
    });
  });

  test("a few minutes after the reading the next low water bounds the level", () => {
    const p = new SignalKTideProvider(0.1);
    p.record("environment.tide.heightNow", 0.42, NOW);
    p.record("environment.tide.heightLow", 0.05, NOW);
    expect(resolveWaterLevel(p, [], undefined, NOW + 2 * 60000, NOW).h).toBe(0.42);
    expect(resolveWaterLevel(p, [], undefined, NOW + 10 * 60000, NOW).h).toBe(0.05);
    expect(lowestWaterLevel(p, [], undefined, NOW, NOW + 2 * HOUR, NOW).h).toBe(0.05);
  });

  test("a falling tide never holds heightNow for a leg or a reading half an hour old", () => {
    const p = new SignalKTideProvider(0.1);
    p.record("environment.tide.heightNow", 2.0, NOW);
    p.record("environment.tide.heightLow", 0.5, NOW);
    expect(lowestWaterLevel(p, [], undefined, NOW, NOW + 28 * 60000, NOW).h).toBe(0.5);
    const later = NOW + 29 * 60000;
    expect(resolveWaterLevel(p, [], undefined, later, later)).toEqual({
      h: 0.5,
      sigma: 0.1,
      source: "signalk-tide"
    });
  });

  test("without heightLow only the current reading is known", () => {
    const p = new SignalKTideProvider(0.1);
    p.record("environment.tide.heightNow", 0.42, NOW);
    expect(resolveWaterLevel(p, [], undefined, NOW + 2 * 60000, NOW).h).toBe(0.42);
    expect(resolveWaterLevel(p, [], undefined, NOW + HOUR, NOW).degraded).toMatch(/no value/);
  });

  test("past six hours after the next low water the level is unknown", () => {
    const p = new SignalKTideProvider(0.1);
    p.record("environment.tide.heightNow", 2.0, NOW);
    p.record("environment.tide.heightLow", 0.5, NOW);
    p.record("environment.tide.timeLow", new Date(NOW + 1.5 * HOUR).toISOString(), NOW);
    expect(lowestWaterLevel(p, [], undefined, NOW, NOW + 7 * HOUR, NOW)).toEqual({
      h: 0.5,
      sigma: 0.1,
      source: "signalk-tide"
    });
    const leg = lowestWaterLevel(p, [], undefined, NOW + 12 * HOUR, NOW + 14 * HOUR, NOW);
    expect(leg.degraded).toMatch(/no value/);
  });

  test("without timeLow the next low water bounds the level for six hours", () => {
    const p = new SignalKTideProvider(0.1);
    p.record("environment.tide.heightNow", 2.0, NOW);
    p.record("environment.tide.heightLow", 0.5, NOW);
    expect(resolveWaterLevel(p, [], undefined, NOW + 5 * HOUR, NOW).h).toBe(0.5);
    expect(resolveWaterLevel(p, [], undefined, NOW + 7 * HOUR, NOW).degraded).toMatch(/no value/);
  });

  test("a stale negative reading falls back to that reading", () => {
    const p = new SignalKTideProvider(0.1);
    p.record("environment.tide.heightNow", -0.4, NOW);
    const later = NOW + 40 * 60000;
    expect(resolveWaterLevel(p, [], undefined, later, later)).toEqual({
      h: -0.4,
      sigma: CHART_DATUM_SIGMA,
      source: "fallback",
      degraded: "water level from signalk-tide is 40 min old"
    });
  });

  test("a reading older than 30 minutes is stale", () => {
    const p = new SignalKTideProvider(0.1);
    p.record("environment.tide.heightNow", 0.42, NOW);
    expect(resolveWaterLevel(p, [], undefined, NOW + 40 * 60000, NOW + 40 * 60000).degraded).toBe(
      "water level from signalk-tide is 40 min old"
    );
  });
});
