import { performance } from "perf_hooks";
import { evaluateLookahead } from "../../src/engine/lookahead";
import type { NavState } from "../../src/engine/lookahead";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { ChartFeature } from "../../src/ingest/features";
import { ctx } from "../helpers/engine";
import { area, basin, point } from "../helpers/synthetic";

/**
 * Look-ahead tick cost (plan §6: < 20 ms on a Raspberry Pi 4) on a
 * synthetic archipelago at leaf z20, with and without the escape fan.
 * Run with `npm run bench`; Jest's sandbox makes this slower than the
 * plugin runs in Signal K.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("look-ahead benchmark", () => {
  test("ticks with and without the escape fan", () => {
    const r = rng(5);
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
    const NOW = 1_800_000_000_000;
    const navs: NavState[] = Array.from({ length: 60 }, () => ({
      position: { value: [22.02 + r() * 0.14, 60.01 + r() * 0.07], at: NOW },
      cog: { value: r() * 2 * Math.PI, at: NOW },
      sog: { value: 1 + r() * 5, at: NOW },
      rot: { value: (r() - 0.5) * 0.02, at: NOW }
    }));
    const vessel = { draft: 2.2, length: 12, beam: 4 };
    const time = (escape: boolean) => {
      const ms: number[] = [];
      let alerting = 0;
      for (const nav of navs) {
        const t0 = performance.now();
        const res = evaluateLookahead(nav, { ...ctx(vessel), escape }, index, NOW);
        ms.push(performance.now() - t0);
        alerting += res.state === "normal" ? 0 : 1;
      }
      ms.sort((a, b) => a - b);
      const p = (q: number) => (ms[Math.floor(q * (ms.length - 1))] as number).toFixed(2);
      process.stdout.write(
        `look-ahead${escape ? " + escape" : ""}: median ${p(0.5)} ms, p95 ${p(0.95)} ms (${alerting}/${ms.length} not normal)\n`
      );
    };
    time(false);
    time(true);
  });
});
