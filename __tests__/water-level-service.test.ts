import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import type { FetchLike } from "../src/model/fmi";
import type { ChartIndex } from "../src/spatial/chart-index";
import { WaterLevelService } from "../src/water-level-service";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3600 * 1000;
const HELSINKI: LonLat = [24.95, 60.14];
const noFetch: FetchLike = () => Promise.reject(new Error("offline"));
const index = {
  catalogue: { cells: [{ name: "A", edition: 1, update: 0, band: 5, soundingDatum: 26 }] }
} as unknown as ChartIndex;

/** An hourly FMI forecast of 20 cm above mean water from 2 h before NOW for 72 h. */
function forecastXml(): string {
  const rows: string[] = [];
  for (let k = -2; k <= 72; k++) {
    const t = new Date(NOW + k * HOUR).toISOString();
    rows.push(
      `<BsWfs:BsWfsElement><BsWfs:Time>${t}</BsWfs:Time><BsWfs:ParameterName>SeaLevel</BsWfs:ParameterName><BsWfs:ParameterValue>20</BsWfs:ParameterValue></BsWfs:BsWfsElement>`
    );
  }
  return `<wfs:FeatureCollection>${rows.join("")}</wfs:FeatureCollection>`;
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
