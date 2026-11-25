import fc from "fast-check";
import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import { haversine, tileAt, toMercator } from "../src/foundation/geo";
import type { FetchLike } from "../src/model/fmi";
import { levelOver, tileCorners } from "../src/model/level-regimes";
import type { ChartIndex } from "../src/spatial/chart-index";
import { WaterLevelService } from "../src/water-level-service";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3600 * 1000;
const HELSINKI: LonLat = [24.95, 60.14];
const noFetch: FetchLike = () => Promise.reject(new Error("offline"));
const index = {
  catalogue: { cells: [{ name: "A", edition: 1, update: 0, band: 5, soundingDatum: 26 }] }
} as unknown as ChartIndex;

/** An hourly FMI forecast of `cm` (or `cm(k)` at hour k) above mean water from 2 h before NOW for 72 h. */
function forecastXml(cm: number | ((k: number) => number) = 20): string {
  const rows: string[] = [];
  for (let k = -2; k <= 72; k++) {
    const t = new Date(NOW + k * HOUR).toISOString();
    rows.push(
      `<BsWfs:BsWfsElement><BsWfs:Time>${t}</BsWfs:Time><BsWfs:ParameterName>SeaLevel</BsWfs:ParameterName><BsWfs:ParameterValue>${typeof cm === "number" ? cm : cm(k)}</BsWfs:ParameterValue></BsWfs:BsWfsElement>`
    );
  }
  return `<wfs:FeatureCollection>${rows.join("")}</wfs:FeatureCollection>`;
}

const KEMI: LonLat = [24.52, 65.67];
const VAASA: LonLat = [21.57, 63.08];

/** An FMI source whose forecast, +0.62 m, was fetched at Kemi at NOW (or none was). */
async function fmiAtKemi(
  fetched = true,
  cm: number | ((k: number) => number) = 62
): Promise<WaterLevelService> {
  const fetch: FetchLike = (url) =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(url.includes("forecast") ? forecastXml(cm) : "<x/>")
    });
  const s = new WaterLevelService(parseConfig({ waterLevel: { source: "fmi" } }), index, fetch);
  if (fetched) {
    s.refresh(KEMI, NOW);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }
  return s;
}

/**
 * Steps the service at 1 Hz for `seconds`, as the monitor's tick does, with
 * FMI answering 2 s after each request; returns the seconds at which the
 * applied level was a fallback.
 */
async function degradedSeconds(
  updateInterval: number,
  seconds: number,
  fails: (request: number) => boolean
): Promise<number[]> {
  const pending: { due: number; settle: () => void }[] = [];
  let clock = NOW;
  let requests = 0;
  const fetch: FetchLike = (url) => {
    const forecast = url.includes("forecast");
    const fail = forecast && fails(requests++);
    return new Promise((resolve) =>
      pending.push({
        due: clock + 2000,
        settle: () =>
          resolve({
            ok: !fail,
            status: fail ? 503 : 200,
            text: () => Promise.resolve(forecast ? forecastXml() : "<x/>")
          })
      })
    );
  };
  const s = new WaterLevelService(
    parseConfig({ waterLevel: { source: "fmi", updateInterval } }),
    index,
    fetch
  );
  const degraded: number[] = [];
  for (let k = 0; k <= seconds; k++) {
    clock = NOW + k * 1000;
    for (const r of pending.filter((p) => p.due <= clock)) {
      pending.splice(pending.indexOf(r), 1);
      r.settle();
    }
    await new Promise((r) => setImmediate(r));
    s.refresh(HELSINKI, clock);
    if (k > 2 && s.now(HELSINKI, clock).degraded !== undefined) {
      degraded.push(k);
    }
  }
  return degraded;
}

describe("the level over an interval, kept by the service", () => {
  test("a second forecast is read at once: the lowest level over the next hours follows it", async () => {
    let cm = 62;
    let forecasts = 0;
    const fetch: FetchLike = (url) => {
      forecasts += url.includes("forecast") ? 1 : 0;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(url.includes("forecast") ? forecastXml(cm) : "<x/>")
      });
    };
    const s = new WaterLevelService(
      parseConfig({ waterLevel: { source: "fmi", updateInterval: 600 } }),
      index,
      fetch
    );
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
    };
    s.refresh(KEMI, NOW);
    await settle();
    const first = s.over(NOW, NOW + 6 * HOUR, [KEMI], NOW);
    expect(first.degraded).toBeUndefined();
    expect(s.over(NOW, NOW + 6 * HOUR, [KEMI], NOW + 1000)).toEqual(first);
    expect(s.highest(NOW, NOW + 6 * HOUR, [KEMI], NOW + 1000).h).toBeCloseTo(first.h, 9);
    cm = 12;
    s.refresh(KEMI, NOW + 601_000);
    await settle();
    expect(forecasts).toBe(2);
    const second = s.over(NOW, NOW + 6 * HOUR, [KEMI], NOW + 602_000);
    expect(second.h).toBeCloseTo(first.h - 0.5, 9);
  });
});

describe("water-level service", () => {
  test("the Signal K tide source reads heightNow, heightLow and timeLow", () => {
    const s = new WaterLevelService(
      parseConfig({ waterLevel: { source: "signalk-tide" } }),
      undefined,
      noFetch
    );
    expect(s.paths()).toEqual([
      "environment.tide.heightNow",
      "environment.tide.heightLow",
      "environment.tide.timeLow"
    ]);
    expect(s.record("environment.tide.timeLow", new Date(NOW).toISOString(), NOW)).toBe(true);
  });

  test("with no source the level is degraded on a mean-water chart, not on a low-water one", () => {
    const none = parseConfig({});
    expect(none.waterLevel.source).toBe("none");
    const mean = new WaterLevelService(none, index, noFetch);
    expect(mean.now(HELSINKI, NOW).degraded).toMatch(/VERDAT 26/);
    expect(mean.status(HELSINKI, NOW).applied.degraded).toMatch(/set Water level source to fmi/);
    expect(mean.over(NOW, NOW + HOUR, [HELSINKI], NOW).degraded).toMatch(/VERDAT 26/);
    const low = {
      catalogue: { cells: [{ name: "B", edition: 1, update: 0, band: 5, soundingDatum: 23 }] }
    } as unknown as ChartIndex;
    mean.setIndex(low);
    expect(mean.now(HELSINKI, NOW).degraded).toBeUndefined();
    expect(new WaterLevelService(none, undefined, noFetch).now(HELSINKI, NOW).degraded).toBe(
      undefined
    );
  });

  test("with a 30-minute FMI interval the level never goes stale between fetches", async () => {
    expect(await degradedSeconds(1800, 2 * 3600, () => false)).toEqual([]);
  });

  test("a failed FMI refetch is retried before the held forecast goes stale", async () => {
    expect(await degradedSeconds(600, 3600, (request) => request === 1)).toEqual([]);
    expect(await degradedSeconds(1800, 3600, (request) => request === 1)).toEqual([]);
  });
});

describe("water level over areas", () => {
  test("a source without a reach gives one level everywhere", () => {
    const s = new WaterLevelService(
      parseConfig({ waterLevel: { source: "manual", height: 0.4, sigma: 0.05 } }),
      index,
      noFetch
    );
    expect(s.regimes(NOW)).toEqual({ inside: { h: 0.4, sigma: 0.05, source: "manual" } });
  });

  test("FMI before its first forecast, or stale, gives one fallback everywhere", async () => {
    const before = (await fmiAtKemi(false)).regimes(NOW);
    expect(before.inside.degraded).toMatch(/no forecast fetched yet/);
    expect(before.beyond).toBeUndefined();
    const stale = (await fmiAtKemi()).regimes(NOW + 31 * 60000);
    expect(stale.inside.degraded).toBe("water level from fmi is 31 min old");
    expect(stale.beyond).toBeUndefined();
  });

  test("a fresh FMI forecast holds within 30 km of Kemi, and beyond it the level a leg would get", async () => {
    const s = await fmiAtKemi();
    const r = s.regimes(NOW);
    expect(r.inside).toEqual(s.now(KEMI, NOW));
    expect(r.inside).toMatchObject({ h: 0.62, source: "fmi:forecast" });
    expect(r.inside.degraded).toBeUndefined();
    expect(r.beyond?.reach).toEqual({ centre: KEMI, metres: 30000 });
    expect(r.beyond?.level).toEqual(s.over(NOW, NOW, [KEMI, VAASA], NOW));
    expect(r.beyond?.level.degraded).toMatch(/fmi/);
    expect(r.beyond?.level.h).toBeLessThanOrEqual(r.inside.h);
  });

  test("a ring the reach cuts into gets no more water than a point inside it, every vertex beyond", async () => {
    // Falling from +20 cm: the window's lowest within the reach is below the fallback.
    const s = await fmiAtKemi(true, (k) => 20 - 10 * (k + 2));
    const k = { n: 1 / 111195, e: 1 / (111195 * Math.cos((KEMI[1] * Math.PI) / 180)) };
    const at = (east: number, north: number): LonLat => [
      KEMI[0] + east * k.e,
      KEMI[1] + north * k.n
    ];
    // A 10 km × 0.5 km box whose south edge passes 29.8 km north of Kemi: its corners lie
    // past the 30 km reach, the middle of its south edge inside it.
    const ring = [at(-5000, 29800), at(5000, 29800), at(5000, 30300), at(-5000, 30300)];
    const inside = at(0, 29800);
    expect(ring.every((c) => haversine(c, KEMI) > 30000)).toBe(true);
    expect(haversine(inside, KEMI)).toBeLessThan(30000);
    const own = s.over(NOW, NOW + 6 * HOUR, [inside], NOW);
    expect(s.over(NOW, NOW + 6 * HOUR, ring, NOW).h).toBeGreaterThan(own.h);
    expect(s.over(NOW, NOW + 6 * HOUR, ring, NOW, true).h).toBeLessThanOrEqual(own.h);
    // Far from the reach the area changes nothing.
    const far = [VAASA, at(0, -300000), at(5000, -300000)];
    expect(s.over(NOW, NOW + 6 * HOUR, far, NOW, true)).toEqual(
      s.over(NOW, NOW + 6 * HOUR, far, NOW)
    );
  });

  test("positions on one side of the reach ask once: the level every position's own folds to", async () => {
    const s = await fmiAtKemi(true, (k) => 20 - 10 * (k + 2));
    const places: LonLat[] = [KEMI, [24.6, 65.7], [24.4, 65.6], VAASA, [21.6, 63.1]];
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...places), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 12 }),
        (at, hours) => {
          const end = NOW + hours * HOUR;
          const low = at.map((p) => s.over(NOW, end, [p], NOW));
          const high = at.map((p) => s.highest(NOW, end, [p], NOW));
          const fold = (ls: typeof low, pick: (a: number, b: number) => number) =>
            ls.reduce((a, b) => {
              const base = a.degraded === undefined && b.degraded !== undefined ? b : a;
              return { ...base, h: pick(a.h, b.h), sigma: Math.max(a.sigma, b.sigma) };
            });
          expect(s.over(NOW, end, at, NOW)).toEqual(fold(low, Math.min));
          expect(s.highest(NOW, end, at, NOW)).toEqual(fold(high, Math.max));
          return Promise.resolve();
        }
      ),
      { numRuns: 100 }
    );
  });

  test("beyond the forecast's reach the reason names the distance, not a missing time", async () => {
    const s = await fmiAtKemi();
    expect(s.now(VAASA, NOW).degraded).toBe(
      "water level from fmi: more than 30 km from where its forecast was fetched"
    );
    expect(s.regimes(NOW).beyond?.level.degraded).toBe(
      "water level from fmi: more than 30 km from where its forecast was fetched"
    );
  });

  test("a tile or point never gets more water or a narrower σ than the level at its own positions", async () => {
    // Invariant 2: the level over an area is no wetter than any position in it would get.
    const s = await fmiAtKemi();
    const r = s.regimes(NOW);
    const near = fc.tuple(
      fc.double({ min: KEMI[0] - 1, max: KEMI[0] + 1, noNaN: true }),
      fc.double({ min: KEMI[1] - 0.5, max: KEMI[1] + 0.5, noNaN: true })
    );
    fc.assert(
      fc.property(fc.integer({ min: 11, max: 16 }), near, (z, p) => {
        const [mx, my] = toMercator(p[0], p[1]);
        const t = tileAt(z, mx, my);
        const corners = tileCorners(z, t.x, t.y);
        const lvl = levelOver(r, corners);
        const o = s.over(NOW, NOW, corners, NOW);
        expect(lvl.h).toBeLessThanOrEqual(o.h);
        expect(lvl.sigma).toBeGreaterThanOrEqual(o.sigma);
        if (o.degraded !== undefined) {
          expect(lvl.degraded).toBeDefined();
        }
        if (corners.every((c) => haversine(c, KEMI) <= 30000)) {
          expect(lvl).toEqual(o);
        }
        const at = levelOver(r, [p]);
        const own = s.now(p, NOW);
        expect(at.h).toBeLessThanOrEqual(own.h);
        expect(at.sigma).toBeGreaterThanOrEqual(own.sigma);
        if (own.degraded !== undefined) {
          expect(at.degraded).toBeDefined();
        }
      }),
      { numRuns: 300 }
    );
  });
});
