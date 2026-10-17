import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import { quadkey } from "../../src/livechart/discrepancy";
import { isDiscrepancy, PASS_GAP_MS, Posteriors } from "../../src/livechart/posterior";
import type { RawSounding, SoundingSource } from "../../src/livechart/soundings";
import { reduce } from "../../src/livechart/soundings";
import { haversine, project } from "../../src/foundation/geo";
import type { LonLat } from "../../src/foundation/geo";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { basin } from "../helpers/synthetic";

const T0 = 1_800_000_000_000;
const SURFACE: SoundingSource = {
  path: "environment.depth.belowSurface",
  transducerDepth: 0,
  forward: 0,
  starboard: 0
};
const WL = { h: 0.2, sigma: 0.05, source: "manual" };
const SHOAL: LonLat = [22.05, 60.05];
const CONFIG: LivechartConfig = {
  source: SURFACE,
  writeNotes: true,
  csb: { id: "anon", idType: "Other" }
};

function raw(depth: number, at: number, extra: Partial<RawSounding> = {}): RawSounding {
  return {
    depth,
    at,
    position: SHOAL,
    heading: 0,
    hdop: 0.9,
    methodQuality: "GNSS Fix",
    roll: 0,
    waterLevel: WL,
    ...extra
  };
}

const store = () => buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 });

const failOnError = {
  setNote: () => Promise.resolve(),
  error: (m: string) => {
    throw new Error(m);
  }
};

describe("sounding reduction", () => {
  test("depth below the surface less the water level, with the plan's σ", () => {
    const r = reduce(raw(4.2, T0), SURFACE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sounding.belowSurface).toBe(4.2);
      expect(r.sounding.depth).toBeCloseTo(4.0, 9);
      expect(r.sounding.sigma).toBeCloseTo(0.1 + 0.042 + 0.05, 9);
    }
  });

  test("a transducer reading adds its depth; the lever arm moves the position", () => {
    const r = reduce(raw(3, T0, { heading: Math.PI / 2 }), {
      path: "environment.depth.belowTransducer",
      transducerDepth: 0.6,
      forward: 4,
      starboard: 1
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sounding.belowSurface).toBeCloseTo(3.6, 9);
      expect(haversine(r.sounding.position, SHOAL)).toBeCloseTo(Math.hypot(4, 1), 1);
      expect(r.sounding.position[0]).toBeGreaterThan(SHOAL[0]);
    }
  });

  test("the quality gate keeps only good fixes, valid depths, small roll and a real water level", () => {
    const bad: [Partial<RawSounding>, RegExp][] = [
      [{ position: undefined }, /no position/],
      [{ methodQuality: "Estimated (DR) mode" }, /fix quality/],
      [{ hdop: 2.5 }, /HDOP/],
      [{ hdop: undefined }, /HDOP unknown/],
      [{ roll: 0.3 }, /roll/],
      [{ depth: 0.1 }, /out of range/],
      [{ depth: NaN }, /out of range/],
      [{ waterLevel: { ...WL, degraded: "water level from fmi is 40 min old" } }, /water level/]
    ];
    for (const [extra, why] of bad) {
      const r = reduce({ ...raw(4, T0), ...extra }, SURFACE);
      expect(r.ok ? "" : r.reason).toMatch(why);
    }
    expect(reduce(raw(4, T0, { heading: undefined }), { ...SURFACE, forward: 2 })).toEqual({
      ok: false,
      reason: "no heading for the lever arm"
    });
  });
});

describe("cell posterior and discrepancy", () => {
  test("soundings pull the posterior from the chart prior; passes need a 10-minute gap", () => {
    const p = new Posteriors(store());
    const s = (at: number) => {
      const r = reduce(raw(5.2, at), SURFACE);
      if (!r.ok) {
        throw new Error(r.reason);
      }
      return r.sounding;
    };
    let c = p.add(s(T0));
    expect(c.chartDepth).toBe(8);
    expect(c.samples).toBe(1);
    expect(c.passes).toBe(1);
    for (let k = 1; k < 5; k++) {
      c = p.add(s(T0 + k * 1000));
    }
    expect(c.passes).toBe(1);
    expect(c.mean).toBeLessThan(5.3);
    expect(isDiscrepancy(c)).toBe(false);
    c = p.add(s(T0 + PASS_GAP_MS + 5000));
    expect(c.passes).toBe(2);
    expect(isDiscrepancy(c)).toBe(true);
  });

  test("M5 exit: the synthetic shoal is found after two passes, lowers queries and writes a note", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    const pyramid = store();
    const notes: [string, Record<string, unknown>][] = [];
    const svc = new LivechartService(pyramid, CONFIG, file, {
      ...failOnError,
      setNote: (id, body) => {
        notes.push([id, body]);
        return Promise.resolve();
      }
    });
    const before = minDepthOver(pyramid, footprintGeom([SHOAL]));
    // Two passes over a 5 m shoal charted at 8 m, three readings each, 15 minutes apart.
    for (const start of [T0, T0 + 15 * 60_000]) {
      for (let k = 0; k < 3; k++) {
        svc.onSounding(raw(5.2, start + k * 1000, { position: project(SHOAL, 0, k) }));
      }
    }
    const after = minDepthOver(pyramid, footprintGeom([SHOAL]));
    expect(before.dMin).toBe(8);
    expect(after.dMin).toBeLessThan(5.3);
    expect(after.flags & FLAGS.LIVECHART_ADJUSTED).toBeTruthy();
    // One note per cell, rewritten as the evidence grows.
    expect(new Set(notes.map(([id]) => id)).size).toBe(1);
    expect(notes[0]?.[0]).toMatch(/^underkeel-shoal-[0-3]{18}$/);
    expect(notes.at(-1)?.[1]).toMatchObject({
      name: expect.stringMatching(/^Suspected shoal 5(\.\d+)? m \(charted 8 m\)$/)
    });
    expect(svc.discrepancies()).toHaveLength(1);
    expect(svc.status()).toMatchObject({ accepted: 6, discrepancies: 1 });

    // Deeper readings later never make the cell deeper again (invariant 5).
    for (let k = 0; k < 20; k++) {
      svc.onSounding(raw(12, T0 + 40 * 60_000 + k * 1000));
    }
    expect(minDepthOver(pyramid, footprintGeom([SHOAL])).dMin).toBeLessThan(5.3);

    // The state survives a restart.
    svc.save();
    const fresh = store();
    const reloaded = new LivechartService(fresh, CONFIG, file, failOnError);
    expect(minDepthOver(fresh, footprintGeom([SHOAL])).dMin).toBeLessThan(5.3);
    expect(reloaded.discrepancies()).toHaveLength(1);
    const csb = reloaded.csb() as {
      features: unknown[];
      properties: { platform: { uniqueID: string } };
    };
    expect(csb.features).toHaveLength(26);
    expect(csb.properties.platform.uniqueID).toBe("anon");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the chart prior ignores adjustments, so a cell is compared with the chart alone", () => {
    const pyramid = store();
    const svc = new LivechartService(
      pyramid,
      CONFIG,
      path.join(os.tmpdir(), "unused.json"),
      failOnError
    );
    for (const start of [T0, T0 + 15 * 60_000]) {
      for (let k = 0; k < 3; k++) {
        svc.onSounding(raw(5.2, start + k * 1000));
      }
    }
    const p = new Posteriors(pyramid);
    const r = reduce(raw(5.2, T0), SURFACE);
    expect(r.ok && p.add(r.sounding).chartDepth).toBe(8);
  });

  test("rejected readings are counted by reason", () => {
    const svc = new LivechartService(
      store(),
      { ...CONFIG, writeNotes: false },
      path.join(os.tmpdir(), "never-written.json"),
      failOnError
    );
    svc.onSounding(raw(4, T0, { hdop: 3.1 }));
    svc.onSounding(raw(4, T0, { hdop: 2.4 }));
    expect(svc.status()).toMatchObject({ accepted: 0, rejected: { "HDOP #": 2 } });
  });

  test("quadkeys follow the Bing tile scheme", () => {
    expect(quadkey(3, 3, 5)).toBe("213");
    expect(quadkey(1, 0, 0)).toBe("0");
  });
});

describe("safety invariant 5", () => {
  test("no sequence of own soundings makes any query deeper", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.double({ min: 0, max: 1, noNaN: true }),
            fc.double({ min: 0, max: 1, noNaN: true }),
            fc.double({ min: 0.5, max: 25, noNaN: true }),
            fc.integer({ min: 0, max: 7200 })
          ),
          { maxLength: 60 }
        ),
        fc.array(
          fc.tuple(
            fc.double({ min: 0, max: 1, noNaN: true }),
            fc.double({ min: 0, max: 1, noNaN: true })
          ),
          { minLength: 1, maxLength: 8 }
        ),
        (soundings, probes) => {
          const pyramid = store();
          const at = (u: number, v: number): LonLat => [22.04 + u * 0.02, 60.04 + v * 0.01];
          const geoms = probes.map(([u, v]) => footprintGeom([at(u, v)]));
          const before = geoms.map((g) => minDepthOver(pyramid, g, { bufferMetres: 20 }).dMin);
          const svc = new LivechartService(
            pyramid,
            { ...CONFIG, writeNotes: false },
            path.join(os.tmpdir(), "unused.json"),
            failOnError
          );
          for (const [u, v, d, s] of soundings) {
            svc.onSounding(raw(d, T0 + s * 1000, { position: at(u, v) }));
          }
          geoms.forEach((g, i) => {
            expect(minDepthOver(pyramid, g, { bufferMetres: 20 }).dMin).toBeLessThanOrEqual(
              before[i] as number
            );
          });
        }
      ),
      { numRuns: 80 }
    );
  });
});
