import { performance } from "perf_hooks";
import type { XY } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { ChartFeature, DepthFeature } from "../../src/ingest/features";
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

    process.stdout.write(
      [
        `features:        ${features.length}`,
        `nodes:           ${store.count}`,
        `build:           ${buildMs.toFixed(0)} ms`,
        `query/footprint: ${queryMs.toFixed(3)} ms (budget 1 ms on Pi 4)`,
        `visits/query:    ${(visits / N).toFixed(1)}`,
        `heap used:       ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`
      ].join("\n") + "\n"
    );
    expect(store.count).toBeGreaterThan(0);
  });
});

/**
 * A closed coastline of `n` vertices around `centre`: a radius per angle from
 * periodic midpoint displacement, so the ring is star-shaped and never crosses
 * itself, and as ragged as a real skerry coast at every scale.
 */
function coastline(r: () => number, centre: XY, radius: number, n: number): XY[] {
  let radii = Array.from({ length: 8 }, () => radius * (0.8 + 0.4 * r()));
  let rough = radius * 0.25;
  while (radii.length < n) {
    radii = radii.flatMap((a, i) => {
      const b = radii[(i + 1) % radii.length] as number;
      return [a, Math.max(radius * 0.1, (a + b) / 2 + (r() - 0.5) * rough)];
    });
    rough /= 1.6;
  }
  return radii.map((d, i) => {
    const a = (2 * Math.PI * i) / radii.length;
    return [centre[0] + d * Math.cos(a), centre[1] + d * Math.sin(a)];
  });
}

function ringArea(ring: XY[], depth: number, objectClass: string): DepthFeature {
  const geom: Geom = { type: "polygon", polygons: [{ outer: ring, holes: [] }] };
  return {
    role: "depth",
    objectClass,
    geom,
    depth,
    hazard: false,
    dredged: false,
    cellRef: 0,
    band: 5
  };
}

/**
 * Real cells have rings of thousands of vertices (FI4WFS01: a 24 334-vertex land area and
 * DEPARE rings up to 6 662), where the build spends nearly all its time in ring tests;
 * the 5-vertex boxes above never show that cost.
 */
function coastScenario(): ChartFeature[] {
  const r = rng(11);
  const centre = toMercator(W + SPAN_LON / 2, S + SPAN_LAT / 2);
  // Mercator metres; at 60° N one is half a metre of ground.
  const features: ChartFeature[] = [...basin([W, S, W + SPAN_LON, S + SPAN_LAT], 25)];
  features.push(ringArea(coastline(r, centre, 6000, 24_000), -Infinity, "LNDARE"));
  [2, 4, 6, 8].forEach((depth, i) =>
    features.push(ringArea(coastline(r, centre, 6500 + 1200 * i, 6_000), depth, "DEPARE"))
  );
  for (let i = 0; i < 1000; i++) {
    features.push(
      point(W + r() * SPAN_LON, S + r() * SPAN_LAT, 2 + r() * 20, { objectClass: "SOUNDG" })
    );
  }
  return features;
}

describe("pyramid benchmark, real-sized rings", () => {
  test("build cost with a 24 000-vertex coastline", () => {
    const features = coastScenario();
    const vertices = features.reduce(
      (n, f) => n + (f.geom.type === "polygon" ? (f.geom.polygons[0]?.outer.length ?? 0) : 0),
      0
    );
    const t0 = performance.now();
    const store = buildPyramid(features, { minZoom: 10, leafZoom: 20 });
    const buildMs = performance.now() - t0;
    process.stdout.write(
      [
        `polygon vertices: ${vertices}`,
        `nodes:            ${store.count}`,
        `build:            ${buildMs.toFixed(0)} ms (leaf zoom 20)`
      ].join("\n") + "\n"
    );
    expect(store.count).toBeGreaterThan(0);
  });
});
