import type { LonLat } from "../../src/foundation/geo";
import { datumUses } from "../../src/ingest/datum";
import type { FetchLike } from "../../src/model/fmi";
import {
  FMI_SIGMA,
  FmiProvider,
  interpolate,
  nearestStation,
  parseSimpleFeatures
} from "../../src/model/fmi";
import { lowestWaterLevel, resolveWaterLevel } from "../../src/model/water-level";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3600 * 1000;
const HELSINKI: LonLat = [24.95, 60.14];

/** A WFS "simple" feature response, as opendata.fmi.fi returns it. */
function simple(rows: [t: number, name: string, value: number | "NaN"][]): string {
  const members = rows.map(
    ([t, name, value], i) => `
  <wfs:member>
    <BsWfs:BsWfsElement gml:id="BsWfsElement.1.${i}">
      <BsWfs:Location><gml:Point><gml:pos>60.15 24.96 </gml:pos></gml:Point></BsWfs:Location>
      <BsWfs:Time>${new Date(t).toISOString().replace(".000", "")}</BsWfs:Time>
      <BsWfs:ParameterName>${name}</BsWfs:ParameterName>
      <BsWfs:ParameterValue>${value}</BsWfs:ParameterValue>
    </BsWfs:BsWfsElement>
  </wfs:member>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<wfs:FeatureCollection>${members.join("")}\n</wfs:FeatureCollection>`;
}

/** Hourly forecast from 1 h ago for 48 h: theoretical mean water 20 cm, N2000 40 cm. */
function forecastXml(): string {
  const rows: [number, string, number][] = [];
  for (let k = -1; k <= 48; k++) {
    rows.push([NOW + k * HOUR, "SeaLevel", 20], [NOW + k * HOUR, "SeaLevelN2000", 40]);
  }
  return simple(rows);
}

/** Gauge 10 min ago: 250 mm above theoretical mean water, 450 mm above N2000. */
function observationXml(): string {
  const t = NOW - 10 * 60000;
  return simple([
    [t - 60000, "WATLEV", 240],
    [t, "WATLEV", 250],
    [t, "WLEVN2K_PT1S_INSTANT", 450],
    [t, "TW", 12.3]
  ]);
}

function fakeFetch(
  answer: (query: string) => { status: number; body?: string } | Error
): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f = (url: string) => {
    urls.push(url);
    const a = answer(new URL(url).searchParams.get("storedquery_id") ?? "");
    if (a instanceof Error) {
      return Promise.reject(a);
    }
    return Promise.resolve({
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      text: () => Promise.resolve(a.body ?? "")
    });
  };
  return Object.assign(f, { urls });
}

const BOTH = (q: string) => ({
  status: 200,
  body: q.includes("forecast") ? forecastXml() : observationXml()
});

describe("FMI response parsing", () => {
  test("simple features become sorted series per parameter, NaN dropped", () => {
    const xml = simple([
      [NOW + HOUR, "SeaLevel", 5],
      [NOW, "SeaLevel", -1.6],
      [NOW, "SeaLevelN2000", "NaN"]
    ]);
    const s = parseSimpleFeatures(xml);
    expect(s.get("SeaLevel")).toEqual([
      [NOW, -1.6],
      [NOW + HOUR, 5]
    ]);
    expect(s.has("SeaLevelN2000")).toBe(false);
  });

  test("interpolation is linear inside the series and undefined outside", () => {
    const s: [number, number][] = [
      [0, 1],
      [10, 3]
    ];
    expect(interpolate(s, 5)).toBe(2);
    expect(interpolate(s, 10)).toBe(3);
    expect(interpolate(s, 11)).toBeUndefined();
    expect(interpolate([], 0)).toBeUndefined();
  });

  test("the nearest mareograph to Helsinki harbour is Kaivopuisto", () => {
    expect(nearestStation(HELSINKI).station.fmisid).toBe(132310);
    expect(nearestStation(HELSINKI).km).toBeLessThan(5);
  });
});

describe("FMI provider", () => {
  test("queries the forecast at the vessel and the nearest gauge", async () => {
    const fetch = fakeFetch(BOTH);
    await new FmiProvider(fetch).update(HELSINKI, NOW);
    const forecast = new URL(fetch.urls.find((u) => u.includes("forecast")) as string);
    expect(forecast.searchParams.get("storedquery_id")).toBe(
      "fmi::forecast::sealevel::point::simple"
    );
    expect(forecast.searchParams.get("latlon")).toBe("60.1400,24.9500");
    expect(forecast.searchParams.get("parameters")).toBe("SeaLevel,SeaLevelN2000");
    const obs = new URL(fetch.urls.find((u) => u.includes("mareograph")) as string);
    expect(obs.searchParams.get("fmisid")).toBe("132310");
    expect(obs.searchParams.get("parameters")).toBe("WATLEV,WLEVN2K_PT1S_INSTANT");
  });

  test("forecast centimetres and gauge millimetres both come out in metres", async () => {
    const p = new FmiProvider(fakeFetch(BOTH));
    await p.update(HELSINKI, NOW);
    const obsTime = NOW - 10 * 60000;
    expect(p.levelAt(HELSINKI, obsTime, "mw")).toMatchObject({ source: "fmi:blend" });
    expect(p.levelAt(HELSINKI, obsTime, "mw")?.h).toBeCloseTo(0.25, 9);
    expect(p.levelAt(HELSINKI, obsTime, "n2000")?.h).toBeCloseTo(0.45, 9);
  });

  test("the gauge offset relaxes to the forecast and σ grows with lead time", async () => {
    const p = new FmiProvider(fakeFetch(BOTH));
    await p.update(HELSINKI, NOW);
    const leads = [0, 1, 6, 24, 47].map((h) => p.levelAt(HELSINKI, NOW + h * HOUR, "mw"));
    const hs = leads.map((s) => s?.h as number);
    const sigmas = leads.map((s) => s?.sigma as number);
    expect(hs[0]).toBeLessThan(0.25);
    expect(hs[0]).toBeGreaterThan(0.245);
    expect(hs[4]).toBeCloseTo(0.2, 3);
    for (let i = 1; i < leads.length; i++) {
      expect(hs[i]).toBeLessThan(hs[i - 1] as number);
      expect(sigmas[i]).toBeGreaterThan(sigmas[i - 1] as number);
    }
    expect(Math.max(...sigmas)).toBeLessThanOrEqual(FMI_SIGMA.max);
  });

  test("without a gauge reading the forecast alone is used, with its own σ", async () => {
    const p = new FmiProvider(
      fakeFetch((q) => (q.includes("forecast") ? BOTH(q) : { status: 503 }))
    );
    await p.update(HELSINKI, NOW);
    expect(p.levelAt(HELSINKI, NOW, "mw")).toEqual({
      h: 0.2,
      sigma: FMI_SIGMA.forecast,
      source: "fmi:forecast"
    });
  });

  test("a failed forecast leaves the provider unhealthy with the reason", async () => {
    const p = new FmiProvider(fakeFetch(() => new Error("ENOTFOUND opendata.fmi.fi")));
    await p.update(HELSINKI, NOW);
    expect(p.health()).toEqual({
      ok: false,
      message: "forecast request failed: Error: ENOTFOUND opendata.fmi.fi"
    });
    const empty = new FmiProvider(fakeFetch(() => ({ status: 200, body: simple([]) })));
    await empty.update(HELSINKI, NOW);
    expect(empty.health().message).toBe("forecast response held no sea-level values");
  });

  test("a failed refresh keeps the last forecast until it is stale", async () => {
    let up = true;
    const p = new FmiProvider(fakeFetch((q) => (up ? BOTH(q) : { status: 500 })));
    const uses = datumUses([{ name: "A", edition: 1, update: 0, band: 5, soundingDatum: 26 }]);
    await p.update(HELSINKI, NOW);
    up = false;
    await p.update(HELSINKI, NOW + 20 * 60000);
    const later = NOW + 25 * 60000;
    expect(resolveWaterLevel(p, uses, HELSINKI, later, later).degraded).toBeUndefined();
    expect(p.health(later).message).toBe("forecast request failed: Error: HTTP 500");
    const stale = NOW + 31 * 60000;
    expect(resolveWaterLevel(p, uses, HELSINKI, stale, stale).degraded).toBe(
      "water level from fmi is 31 min old"
    );
  });

  test("a position far from the forecast point gets no level", async () => {
    const p = new FmiProvider(fakeFetch(BOTH));
    await p.update(HELSINKI, NOW);
    expect(p.levelAt([22.2, 60.4], NOW, "mw")).toBeUndefined();
  });

  test("a datum mismatch widens σ instead of applying the series as is", async () => {
    const p = new FmiProvider(fakeFetch(BOTH));
    await p.update(HELSINKI, NOW);
    const uses = datumUses([{ name: "OLD", edition: 1, update: 0, band: 5, soundingDatum: 13 }]);
    const wl = resolveWaterLevel(p, uses, HELSINKI, NOW, NOW);
    expect(wl.sigma).toBeGreaterThanOrEqual(0.5);
    expect(wl.note).toBe("vertical datum unknown for OLD");
  });

  test("the lowest level over an interval includes the forecast minimum between samples", async () => {
    const trough = simple([
      [NOW - HOUR, "SeaLevel", -10],
      [NOW, "SeaLevel", -10],
      [NOW + HOUR, "SeaLevel", -40],
      [NOW + 2 * HOUR, "SeaLevel", -10]
    ]);
    const p = new FmiProvider(fakeFetch(() => ({ status: 200, body: trough })));
    await p.update(HELSINKI, NOW);
    const uses = datumUses([{ name: "A", edition: 1, update: 0, band: 5, soundingDatum: 26 }]);
    const wl = lowestWaterLevel(p, uses, HELSINKI, NOW + 5 * 60000, NOW + 115 * 60000, NOW);
    expect(wl.h).toBeCloseTo(-0.4, 9);
  });

  test("after abort no request is made", async () => {
    const fetch = fakeFetch(BOTH);
    const p = new FmiProvider(fetch);
    p.abort();
    await p.update(HELSINKI, NOW);
    expect(fetch.urls).toEqual([]);
    expect(p.health().ok).toBe(false);
  });
});
