import { performance } from "perf_hooks";
import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkRoute } from "../../src/engine/route-check";
import { DEFAULT_REPAIR, repairRoute } from "../../src/engine/route-repair";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import { CHART_DATUM } from "../../src/model/water-level";
import type { LonLat } from "../../src/foundation/geo";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { area, basin, point } from "../helpers/synthetic";
import type { ChartFeature } from "../../src/ingest/features";

/**
 * Route check cost (plan §6: 30 legs < 300 ms, one edited leg < 80 ms p95,
 * both on a Raspberry Pi 4). Run with `npm run bench`.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("route check benchmark", () => {
  test("30 legs and single-leg re-checks", async () => {
    const r = rng(3);
    const features: ChartFeature[] = [...basin([22.0, 60.0, 22.18, 60.09], 25)];
    for (let i = 0; i < 80; i++) {
      const lon = 22 + r() * 0.18;
      const lat = 60 + r() * 0.09;
      features.push(area([lon, lat, lon + 0.004, lat + 0.002], r() * 15));
    }
    for (let i = 0; i < 3000; i++) {
      features.push(
        point(22 + r() * 0.18, 60 + r() * 0.09, 2 + r() * 20, { objectClass: "SOUNDG" })
      );
    }
    const index = {
      catalogue: { version: 1 as const, cells: [] },
      pyramid: buildPyramid(features, { minZoom: 10, leafZoom: 20 }),
      hazards: new HazardIndex([])
    };
    const coords: LonLat[] = Array.from({ length: 31 }, (_, i) => [
      22.01 + (i % 2 === 0 ? 0 : 0.16),
      60.005 + i * 0.0026
    ]);
    const input: RouteCheckInput = {
      coordinates: coords,
      departure: 0,
      speeds: Array.from({ length: 30 }, () => 2.5),
      xteLimit: 30,
      planningBuffer: 10,
      vessel: { draft: 1.9, length: 12, beam: 4 },
      dynamics: DEFAULT_DYNAMICS,
      waterLevel: () => CHART_DATUM,
      probability: 0.01
    };
    checkRoute(index, input, 0);
    const t0 = performance.now();
    checkRoute(index, input, 0);
    const fullMs = performance.now() - t0;

    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const leg = { ...input, coordinates: coords.slice(i % 30, (i % 30) + 2), speeds: [2.5] };
      const t = performance.now();
      checkRoute(index, leg, 0);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
    process.stdout.write(
      [
        `30 legs (~9 km each): ${fullMs.toFixed(1)} ms (budget 300 ms on Pi 4)`,
        `one leg p95:          ${p95.toFixed(1)} ms (budget 80 ms on Pi 4)`
      ].join("\n") + "\n"
    );

    // Repair: the worst leg of the 30, if any fails or is marginal.
    const r0 = performance.now();
    const { repairs } = await repairRoute(index, input, { ...DEFAULT_REPAIR, maxLegs: 3 });
    const repairMs = (performance.now() - r0) / Math.max(1, repairs.length);
    process.stdout.write(
      `repair, per leg:      ${repairMs.toFixed(0)} ms over ${repairs.length} legs (budget 1.5 s on Pi 4)\n`
    );
    expect(fullMs).toBeGreaterThan(0);
  });
});
