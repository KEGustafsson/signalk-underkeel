import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import type { LonLat } from "../../src/foundation/geo";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import { CSB_CELL_INTERVAL_MS, CSB_SLOW_SOG, CsbThinner } from "../../src/livechart/csb-thin";
import type { CellPosterior } from "../../src/livechart/posterior";
import { Posteriors } from "../../src/livechart/posterior";
import type { RawSounding, Sounding } from "../../src/livechart/soundings";
import { reduce } from "../../src/livechart/soundings";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { basin } from "../helpers/synthetic";

/**
 * The CSB export log is thinned at low speed; the cell posteriors, and so every discrepancy
 * and lowered depth, still get every accepted sounding (safety invariant 5).
 */

const T0 = 1_800_000_000_000;
const M_PER_DEG_LAT = 111_320;
const BERTH: LonLat = [22.05, 60.05];
const CONFIG: LivechartConfig = {
  source: {
    path: "environment.depth.belowSurface",
    transducerDepth: 0,
    forward: 0,
    starboard: 0
  },
  writeNotes: false,
  csb: { id: "anon", idType: "Other" }
};

const store = () => buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 });

function raw(depth: number, at: number, position: LonLat, sog: number | undefined): RawSounding {
  return {
    depth,
    at,
    position,
    positionAt: at,
    hdop: 0.9,
    methodQuality: "GNSS Fix",
    ...(sog === undefined ? {} : { sog }),
    waterLevel: { h: 0, sigma: 0.05, source: "manual" }
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-csb-thin-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function service(): LivechartService {
  return new LivechartService(store(), CONFIG, path.join(dir, "livechart.json"), {
    setNote: () => Promise.resolve(),
    error: (m) => {
      throw new Error(m);
    },
    now: () => T0
  });
}

const cellsOf = (svc: LivechartService): Map<number, CellPosterior> =>
  (svc as unknown as { posteriors: { cells: Map<number, CellPosterior> } }).posteriors.cells;

const exported = (svc: LivechartService): unknown[] =>
  (svc.csb() as { features: unknown[] }).features;

/** A position `north` metres north of the berth, the GNSS noise at a dock. */
const north = (m: number): LonLat => [BERTH[0], BERTH[1] + m / M_PER_DEG_LAT];

describe("CSB export thinning", () => {
  test("moored at 10 Hz for 10 minutes: the posterior gets all 6000 soundings, the log 10", () => {
    const svc = service();
    const n = 6000;
    for (let i = 0; i < n; i++) {
      svc.onSounding(raw(6 + (i % 7) * 0.01, T0 + i * 100, north((i % 5) * 0.4), 0.05));
    }
    const cells = [...cellsOf(svc).values()];
    expect(cells.reduce((sum, c) => sum + c.samples, 0)).toBe(n);
    expect(svc.status()).toMatchObject({ accepted: n, csbThinned: n - 10 });
    expect(exported(svc)).toHaveLength((n * 100) / CSB_CELL_INTERVAL_MS);
  });

  test("no fresh SOG counts as slow; at 1 kn and above every sounding is logged", () => {
    const still = service();
    const under = service();
    for (let i = 0; i < 100; i++) {
      still.onSounding(raw(6, T0 + i * 100, BERTH, undefined));
      under.onSounding(raw(6, T0 + i * 100, north(i * 0.3), CSB_SLOW_SOG));
    }
    expect(exported(still)).toHaveLength(1);
    expect(exported(under)).toHaveLength(100);
  });

  test("below 1 kn a new cell logs at once", () => {
    const t = new CsbThinner();
    expect(t.keep(1, T0, 0.2)).toBe(true);
    expect(t.keep(1, T0 + 1000, 0.2)).toBe(false);
    expect(t.keep(2, T0 + 2000, 0.2)).toBe(true);
    expect(t.keep(1, T0 + CSB_CELL_INTERVAL_MS - 1, 0.2)).toBe(false);
    expect(t.keep(1, T0 + CSB_CELL_INTERVAL_MS, 0.2)).toBe(true);
    // A clock set back by more than the interval logs rather than waits.
    expect(t.keep(1, T0 - CSB_CELL_INTERVAL_MS, 0.2)).toBe(true);
  });

  test("property: the cells equal those fed every accepted sounding, whatever the thinning", () => {
    const step = fc.record({
      dt: fc.integer({ min: 0, max: 30_000 }),
      north: fc.double({ min: -300, max: 300, noNaN: true }),
      depth: fc.double({ min: 0.5, max: 30, noNaN: true }),
      sog: fc.option(fc.constantFrom(0, 0.1, 0.4, CSB_SLOW_SOG, 3), { nil: undefined })
    });
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 120 }), (steps) => {
        const svc = service();
        const reference = new Posteriors(store());
        const accepted: Sounding[] = [];
        let at = T0;
        for (const s of steps) {
          at += s.dt;
          const r = raw(s.depth, at, north(s.north), s.sog);
          svc.onSounding(r);
          const reduced = reduce(r, CONFIG.source);
          if (reduced.ok) {
            reference.add(reduced.sounding);
            accepted.push(reduced.sounding);
          }
        }
        const logged = exported(svc).length;
        const fast = steps.filter((s) => s.sog !== undefined && s.sog >= CSB_SLOW_SOG).length;
        const status = svc.status() as { accepted: number; csbThinned: number };
        return (
          JSON.stringify([...cellsOf(svc)].sort()) ===
            JSON.stringify([...reference.cells].sort()) &&
          status.accepted === accepted.length &&
          logged + status.csbThinned === accepted.length &&
          logged >= fast
        );
      }),
      { numRuns: 100 }
    );
  });
});
