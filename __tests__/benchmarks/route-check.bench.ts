import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
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
 * both on a Raspberry Pi 4), and the time per unit of route repair work
 * (plan §4.11: one leg's 600 000 units within 1.5 s on a Pi 4). Run with
 * `npm run bench`.
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

/**
 * Repair work calibration, run on the built plugin (lib/) in a plain node
 * process: jest's module sandbox slows global lookups, and timed the same
 * compiled repair about 10× slower than node does. The adversarial chart:
 * 135k soundings at 3.2–5.2 m over 25 m water, 1500 small banks, and
 * a drying wall across the 47 km leg with a gap at 60.10–60.16; the 10 km
 * leg crosses the wall's southern end. Each leg is timed without a limit,
 * for the µs per unit, then with the default limits.
 */
const REPAIR_CALIBRATION = `
const path = require("path");
const { performance } = require("perf_hooks");
const lib = (m) => require(path.join(process.argv[1], ...m.split("/")));
const { DEFAULT_REPAIR, repairSteps } = lib("engine/route-repair");
const { checkLeg, drain } = lib("engine/route-check");
const { DEFAULT_DYNAMICS } = lib("model/vessel");
const { CHART_DATUM } = lib("model/water-level");
const { toMercator } = lib("foundation/geo");
const { HazardIndex } = lib("spatial/hazards");
const { buildPyramid } = lib("spatial/pyramid-build");
const base = { cellRef: 0, band: 5 };
const box = ([w, s, e, n]) => ({
  type: "polygon",
  polygons: [{ outer: [[w, s], [e, s], [e, n], [w, n]].map(([x, y]) => toMercator(x, y)), holes: [] }]
});
const area = (b, depth) => ({
  role: "depth", objectClass: "DEPARE", geom: box(b), depth, hazard: false, dredged: false, ...base
});
const sounding = (lon, lat, depth) => ({
  role: "depth", objectClass: "SOUNDG", geom: { type: "point", p: toMercator(lon, lat) },
  depth, hazard: true, dredged: false, ...base
});
let seed = 7;
const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const B = [21.9, 59.95, 23.1, 60.55];
const features = [
  { role: "coverage", objectClass: "M_COVR", geom: box(B), ...base },
  { role: "quality", objectClass: "M_QUAL", geom: box(B), catzoc: 1, ...base },
  area(B, 25)
];
for (let i = 0; i < 1500; i++) {
  const lon = B[0] + r() * 1.2;
  const lat = B[1] + r() * 0.6;
  features.push(area([lon, lat, lon + 0.004, lat + 0.002], 4 + r() * 11));
}
for (let i = 0; i < 135000; i++) {
  features.push(sounding(B[0] + r() * 1.2, B[1] + r() * 0.6, 3.2 + r() * 2));
}
features.push(area([22.5, 60.16, 22.52, 60.54], 0.5), area([22.5, 59.96, 22.52, 60.1], 0.5));
const index = {
  catalogue: { version: 1, cells: [] },
  pyramid: buildPyramid(features, { minZoom: 10, leafZoom: 18 }),
  hazards: new HazardIndex([])
};
const long = [[22.08, 60.25], [22.93, 60.25]];
const short = [[22.42, 60.165], [22.6, 60.165]];
const cases = [["47 km", long, 40], ["47 km", long, 500], ["47 km", long, 2000],
  ["10 km", short, 500], ["10 km", short, 2000]];
let worst = 0;
for (const [name, coordinates, xteLimit] of cases) {
  const input = {
    coordinates, departure: 0, speeds: [3], xteLimit, planningBuffer: 0,
    vessel: { draft: 1.9, length: 12, beam: 4 }, dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => CHART_DATUM, probability: 0.01
  };
  const { leg } = checkLeg(index, input, 0, 0);
  if (leg.status !== "fail" && leg.status !== "marginal") {
    console.log(name + " ±" + xteLimit + " m: " + leg.status + ", nothing to repair");
    continue;
  }
  const time = (opts) => {
    const t = performance.now();
    const out = drain(repairSteps(index, input, leg, opts));
    return { ...out, ms: performance.now() - t };
  };
  time(DEFAULT_REPAIR);
  const full = time({ ...DEFAULT_REPAIR, maxWork: Infinity });
  const limited = time(DEFAULT_REPAIR);
  const us = (full.ms * 1000) / full.work;
  worst = Math.max(worst, us);
  console.log(
    name + " ±" + xteLimit + " m: " + full.ms.toFixed(0) + " ms, " + Math.round(full.work) +
      " units, " + us.toFixed(2) + " µs/unit (" + (full.repair.reason ?? "repaired") +
      "); default limits: " + limited.ms.toFixed(0) + " ms, " + Math.round(limited.work) +
      " units (" + (limited.repair.reason ?? "repaired") + ")"
  );
}
const seconds = (worst * DEFAULT_REPAIR.maxWork) / 1e6;
console.log("worst " + worst.toFixed(2) + " µs/unit × maxWork " + DEFAULT_REPAIR.maxWork + " = " +
  seconds.toFixed(2) + " s (budget 1.5 s on Pi 4)");
`;

describe("route repair work benchmark", () => {
  test("µs per unit of repair work on near-threshold soundings behind a wall", () => {
    const lib = path.join(__dirname, "..", "..", "lib");
    if (!fs.existsSync(path.join(lib, "engine", "route-repair.js"))) {
      process.stdout.write("repair work: no build in lib/; run `npm run build` first\n");
      return;
    }
    const out = execFileSync(process.execPath, ["-e", REPAIR_CALIBRATION, lib], {
      encoding: "utf8",
      timeout: 600_000
    });
    process.stdout.write(out);
    expect(out).toMatch(/µs\/unit × maxWork/);
  });
});
