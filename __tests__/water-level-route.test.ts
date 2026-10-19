import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import type { FetchLike } from "../src/model/fmi";
import type { ChartIndex } from "../src/spatial/chart-index";
import { WaterLevelService } from "../src/water-level-service";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3600 * 1000;
const HELSINKI: LonLat = [24.95, 60.14];

/** Hourly FMI forecast from 1 h ago for 48 h, 20 cm above theoretical mean water. */
function forecastXml(): string {
  const members: string[] = [];
  for (let k = -1; k <= 48; k++) {
    const t = new Date(NOW + k * HOUR).toISOString().replace(".000", "");
    members.push(`<wfs:member><BsWfs:BsWfsElement gml:id="e${k}">
      <BsWfs:Time>${t}</BsWfs:Time><BsWfs:ParameterName>SeaLevel</BsWfs:ParameterName>
      <BsWfs:ParameterValue>20</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>`);
  }
  return `<wfs:FeatureCollection>${members.join("")}</wfs:FeatureCollection>`;
}

const fetch: FetchLike = (url: string) =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(url.includes("forecast") ? forecastXml() : "")
  });

const index = {
  catalogue: {
    version: 1,
    cells: [{ name: "A", edition: 1, update: 0, band: 5, soundingDatum: 26 }]
  }
} as unknown as ChartIndex;

async function fmiAtHelsinki(): Promise<WaterLevelService> {
  const s = new WaterLevelService(parseConfig({ waterLevel: { source: "fmi" } }), index, fetch);
  s.refresh(HELSINKI, NOW);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
  return s;
}

describe("water level over a route leg", () => {
  test("FMI answers a leg near the forecast point", async () => {
    const s = await fmiAtHelsinki();
    const wl = s.over(NOW, NOW + HOUR, [HELSINKI, [25.0, 60.15]], NOW);
    expect(wl.degraded).toBeUndefined();
    expect(wl.source).toMatch(/^fmi/);
    expect(wl.h).toBeCloseTo(0.2, 6);
  });

  test("a leg beyond the forecast distance falls back, so it is never verified", async () => {
    const s = await fmiAtHelsinki();
    // Porvoo is about 45 km east: the Helsinki forecast does not hold there.
    const wl = s.over(NOW, NOW + HOUR, [HELSINKI, [25.66, 60.39]], NOW);
    expect(wl.source).toBe("fallback");
    expect(wl.degraded).toMatch(/fmi/);
  });
});
