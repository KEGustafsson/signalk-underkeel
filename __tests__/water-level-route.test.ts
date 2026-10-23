import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import type { FetchLike } from "../src/model/fmi";
import type { ChartIndex } from "../src/spatial/chart-index";
import { WaterLevelService } from "../src/water-level-service";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3600 * 1000;
const HELSINKI: LonLat = [24.95, 60.14];

/**
 * Hourly FMI forecast from 1 h ago for 48 h, by default 20 cm above
 * theoretical mean water; `cm` gives the level k hours from NOW.
 */
function forecastXml(cm: (k: number) => number = () => 20): string {
  const members: string[] = [];
  for (let k = -1; k <= 48; k++) {
    const t = new Date(NOW + k * HOUR).toISOString().replace(".000", "");
    members.push(`<wfs:member><BsWfs:BsWfsElement gml:id="e${k}">
      <BsWfs:Time>${t}</BsWfs:Time><BsWfs:ParameterName>SeaLevel</BsWfs:ParameterName>
      <BsWfs:ParameterValue>${cm(k)}</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>`);
  }
  return `<wfs:FeatureCollection>${members.join("")}</wfs:FeatureCollection>`;
}

function fetchOf(cm?: (k: number) => number): FetchLike {
  return (url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(url.includes("forecast") ? forecastXml(cm) : "")
    });
}

const index = {
  catalogue: {
    version: 1,
    cells: [{ name: "A", edition: 1, update: 0, band: 5, soundingDatum: 26 }]
  }
} as unknown as ChartIndex;

async function fmiAtHelsinki(cm?: (k: number) => number): Promise<WaterLevelService> {
  const s = new WaterLevelService(
    parseConfig({ waterLevel: { source: "fmi" } }),
    index,
    fetchOf(cm)
  );
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

  test("a fallback at one end keeps the lower level forecast at the other", async () => {
    // -10 cm when fetched, -60 cm from an hour on: the far end falls back
    // to -0.1 m, which must not hide the -0.6 m forecast at Helsinki.
    const s = await fmiAtHelsinki((k) => (k < 1 ? -10 : -60));
    const wl = s.over(NOW + 2 * HOUR, NOW + 3 * HOUR, [HELSINKI, [25.66, 60.39]], NOW);
    expect(wl.source).toBe("fallback");
    expect(wl.degraded).toMatch(/fmi/);
    expect(wl.h).toBeCloseTo(-0.6, 6);
    expect(wl.sigma).toBeGreaterThanOrEqual(0.3);
  });
});
