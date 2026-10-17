import { performance } from "perf_hooks";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { ChartFeature } from "../../src/ingest/features";
import { area, basin, point, quality, swept } from "../helpers/synthetic";

/**
 * Pyramid build and query cost on a synthetic 10 km × 10 km archipelago
 * (plan §6: < 1 ms per look-ahead footprint on a Raspberry Pi 4). Run with
 * `npm run bench`; numbers from other hardware are indicative only.
 */

const W = 22.0;
const S = 60.0;
const SPAN_LON = 0.18; // ≈ 10 km at 60°N
const SPAN_LAT = 0.09; // ≈ 10 km

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function scenario(): ChartFeature[] {
  const r = rng(42);
  const features: ChartFeature[] = [...basin([W, S, W + SPAN_LON, S + SPAN_LAT], 25)];
  features.push(quality([W, S, W + SPAN_LON / 2, S + SPAN_LAT], 4));
  for (let i = 0; i < 80; i++) {
    const lon = W + r() * SPAN_LON;
    const lat = S + r() * SPAN_LAT;
    const size = 0.002 + r() * 0.01;
    features.push(area([lon, lat, lon + size, lat + size / 2], r() * 15));
  }
  for (let i = 0; i < 3000; i++) {
    features.push(
      point(W + r() * SPAN_LON, S + r() * SPAN_LAT, 2 + r() * 20, { objectClass: "SOUNDG" })
    );
  }
  for (let i = 0; i < 200; i++) {
    features.push(point(W + r() * SPAN_LON, S + r() * SPAN_LAT, r() * 4));
  }
  features.push(swept([W, S + 0.04, W + SPAN_LON, S + 0.042], 6));
  return features;
}

function footprint(lon: number, lat: number): [number, number][] {
  // 12 m × 4 m hull, axis-aligned, around (lon, lat)
  const dLon = 6 / (111320 * Math.cos((lat * Math.PI) / 180));
  const dLat = 2 / 110540;
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat]
  ];
}

describe("pyramid benchmark", () => {
  test("build and query cost", () => {
    const features = scenario();
    const t0 = performance.now();
    const store = buildPyramid(features, { minZoom: 10, leafZoom: 20 });
    const buildMs = performance.now() - t0;

    const r = rng(7);
    const N = 2000;
    let visits = 0;
    const t1 = performance.now();
    for (let i = 0; i < N; i++) {
      const geom = footprintGeom(
        footprint(W + 0.01 + r() * (SPAN_LON - 0.02), S + 0.01 + r() * (SPAN_LAT - 0.02))
      );
      visits += minDepthOver(store, geom, { bufferMetres: 10 }).visits;
    }
    const queryMs = (performance.now() - t1) / N;

    console.log(
      [
        `features:        ${features.length}`,
        `nodes:           ${store.count}`,
        `build:           ${buildMs.toFixed(0)} ms`,
        `query/footprint: ${queryMs.toFixed(3)} ms (budget 1 ms on Pi 4)`,
        `visits/query:    ${(visits / N).toFixed(1)}`,
        `heap used:       ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`
      ].join("\n")
    );
    expect(store.count).toBeGreaterThan(0);
  });
});
