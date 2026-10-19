import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import { quadkey } from "../../src/livechart/discrepancy";
import type { CellPosterior } from "../../src/livechart/posterior";
import {
  chartPrior,
  isDiscrepancy,
  PASS_GAP_MS,
  Posteriors,
  rebasePrior
} from "../../src/livechart/posterior";
import type { RawSounding, SoundingSource } from "../../src/livechart/soundings";
import { reduce } from "../../src/livechart/soundings";
import { haversine, project } from "../../src/foundation/geo";
import type { LonLat } from "../../src/foundation/geo";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { fraction, uniform } from "../helpers/arbitraries";
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
    positionAt: at,
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
      [{ waterLevel: { ...WL, degraded: "water level from fmi is 40 min old" } }, /water level/],
      // 3 s at 6 kn is 9 m, an eighth of a 76 m cell; the position must be that recent.
      [{ positionAt: T0 - 3000 }, /position 3000 ms from the sounding/],
      [{ positionAt: T0 + 2500 }, /position 2500 ms from the sounding/],
      [{ positionAt: undefined }, /position time unknown/]
    ];
    for (const [extra, why] of bad) {
      const r = reduce({ ...raw(4, T0), ...extra }, SURFACE);
      expect(r.ok ? "" : r.reason).toMatch(why);
    }
    expect(reduce(raw(4, T0, { positionAt: T0 - 2000 }), SURFACE).ok).toBe(true);
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

  test("a posterior rebased onto another chart equals one built on that chart", () => {
    const shallow = store();
    const deep = buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 10), { minZoom: 12, leafZoom: 18 });
    const onShallow = new Posteriors(shallow);
    const onDeep = new Posteriors(deep);
    let a: CellPosterior | undefined;
    let b: CellPosterior | undefined;
    for (const [d, at] of [
      [5.2, T0],
      [5.4, T0 + 1000],
      [5.1, T0 + 20 * 60_000]
    ] as const) {
      const r = reduce(raw(d, at), SURFACE);
      if (!r.ok) {
        throw new Error(r.reason);
      }
      a = onShallow.add(r.sounding);
      b = onDeep.add(r.sounding);
    }
    if (!a || !b) {
      throw new Error("no cell");
    }
    const moved = rebasePrior(a, chartPrior(deep, a.z, a.x, a.y));
    expect(moved.chartDepth).toBe(10);
    expect(moved.mean).toBeCloseTo(b.mean, 9);
    expect(moved.sigma).toBeCloseTo(b.sigma, 9);
    expect(moved).toMatchObject({ samples: 3, passes: 2 });
    // Onto no chart at all, the soundings decide alone.
    const alone = rebasePrior(a, { depth: NaN, sigma: 1000, cellRef: -1 });
    const w = [5.2, 5.4, 5.1]
      .map((d) => reduce(raw(d, T0), SURFACE))
      .flatMap((r) => (r.ok ? [r.sounding] : []));
    const p = w.reduce((s, x) => s + 1 / x.sigma ** 2, 0);
    expect(alone.mean).toBeCloseTo(w.reduce((s, x) => s + x.depth / x.sigma ** 2, 0) / p, 9);
  });

  test("a saved state loaded onto a rebuilt chart is judged against that chart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    const svc = new LivechartService(store(), CONFIG, file, failOnError);
    for (const start of [T0, T0 + 15 * 60_000]) {
      for (let k = 0; k < 3; k++) {
        svc.onSounding(raw(5.2, start + k * 1000));
      }
    }
    svc.save();
    const deeper = buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 10), { minZoom: 12, leafZoom: 18 });
    const reloaded = new LivechartService(deeper, CONFIG, file, failOnError);
    expect(reloaded.discrepancies()[0]).toMatchObject({ charted: 10 });
    // The saved adjustment keeps its depth: nothing gets deeper on a reload.
    expect(minDepthOver(deeper, footprintGeom([SHOAL])).dMin).toBeLessThan(5.3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("soundings that agreed with the old chart lower a deeper rebuilt chart on load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    const svc = new LivechartService(store(), CONFIG, file, failOnError);
    // 8.0 m below datum on the 8 m chart: no discrepancy, nothing saved as an adjustment.
    for (const start of [T0, T0 + 15 * 60_000]) {
      for (let k = 0; k < 3; k++) {
        svc.onSounding(raw(8.2, start + k * 1000));
      }
    }
    expect(svc.discrepancies()).toEqual([]);
    svc.save();
    const deeper = buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 10), { minZoom: 12, leafZoom: 18 });
    const reloaded = new LivechartService(deeper, CONFIG, file, failOnError);
    expect(reloaded.discrepancies()[0]).toMatchObject({ charted: 10 });
    expect(minDepthOver(deeper, footprintGeom([SHOAL])).dMin).toBeLessThan(8.3);
    // The adjustment made on load is saved without a new sounding.
    reloaded.save();
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { adjustments: unknown[] };
    expect(saved.adjustments).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a rebuilt index in a running service is judged like a reload", () => {
    // Uncharted at first: the posterior has no prior to be shallower than.
    const away = buildPyramid(basin([23.0, 61.0, 23.1, 61.1], 10), { minZoom: 12, leafZoom: 18 });
    const svc = new LivechartService(away, CONFIG, "", failOnError);
    for (const start of [T0, T0 + 15 * 60_000]) {
      for (let k = 0; k < 3; k++) {
        svc.onSounding(raw(8.2, start + k * 1000));
      }
    }
    expect(svc.discrepancies()).toEqual([]);
    const charted = buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 10), {
      minZoom: 12,
      leafZoom: 18
    });
    svc.rebind(charted);
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10 });
    expect(minDepthOver(charted, footprintGeom([SHOAL])).dMin).toBeLessThan(8.3);
  });

  test("a cell reference saved with another index is replaced by the current chart's", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    const svc = new LivechartService(store(), CONFIG, file, failOnError);
    for (const start of [T0, T0 + 15 * 60_000]) {
      for (let k = 0; k < 3; k++) {
        svc.onSounding(raw(5.2, start + k * 1000));
      }
    }
    svc.save();
    // As if saved against a catalogue that numbered its cells differently.
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
      cells: { cellRef: number }[];
      adjustments: [number, { cellRef: number }][];
    };
    saved.cells.forEach((c) => (c.cellRef = 99));
    saved.adjustments.forEach(([, v]) => (v.cellRef = 99));
    fs.writeFileSync(file, JSON.stringify(saved));
    const fresh = store();
    new LivechartService(fresh, CONFIG, file, failOnError);
    const [[key, v]] = [...fresh.adjustments] as [number, { cellRef: number }][];
    const n = 2 ** fresh.adjustZoom;
    const current = chartPrior(fresh, fresh.adjustZoom, Math.floor(key / n), key % n).cellRef;
    expect(v.cellRef).not.toBe(99);
    expect(v.cellRef).toBe(current);
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

  test("a failed save is reported, not thrown, and is tried again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    const errors: string[] = [];
    const svc = new LivechartService(store(), CONFIG, file, {
      setNote: () => Promise.resolve(),
      error: (m) => errors.push(m)
    });
    svc.onSounding(raw(6, T0));
    // A directory where the temporary file goes makes the write throw.
    fs.mkdirSync(`${file}.tmp-${process.pid}`);
    expect(() => svc.save()).not.toThrow();
    expect(errors).toEqual([expect.stringMatching(/not saved/)]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.tmp-${process.pid}`)).toBe(false);
    svc.save();
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a malformed state file is skipped entry by entry and never stops the start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    const open = (content: string) => {
      fs.writeFileSync(file, content);
      const errors: string[] = [];
      const svc = new LivechartService(store(), CONFIG, file, {
        setNote: () => Promise.resolve(),
        error: (m) => errors.push(m)
      });
      return { svc, errors };
    };
    for (const bad of ["null", "[]", "5", '"x"']) {
      const { svc, errors } = open(bad);
      expect(errors).toEqual([expect.stringMatching(/not a living-chart state/)]);
      expect(svc.discrepancies()).toEqual([]);
    }
    const { svc, errors } = open(
      JSON.stringify({
        version: 1,
        cells: { not: "a list" },
        adjustments: [null, [1], ["k", {}], [5, { dMin: "deep" }]],
        samples: [
          null,
          { at: 1 },
          // Finite but past the Date range: it would make the CSB export throw.
          { at: 1e16, belowSurface: 5, depth: 4.8, sigma: 0.2, position: [22, 60] },
          { at: T0, belowSurface: 5, depth: 4.8, sigma: 0.2, position: [22, 60] }
        ]
      })
    );
    expect(errors).toEqual([expect.stringMatching(/had 8 malformed entries, skipped; moved to/)]);
    expect(svc.discrepancies()).toEqual([]);
    expect((svc.csb() as { features: unknown[] }).features).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a state file that does not load is moved aside, never saved over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    for (const bad of ["{not json", JSON.stringify({ version: 2, cells: [] })]) {
      fs.writeFileSync(file, bad);
      const errors: string[] = [];
      const svc = new LivechartService(store(), CONFIG, file, {
        setNote: () => Promise.resolve(),
        error: (m) => errors.push(m)
      });
      expect(errors).toEqual([expect.stringMatching(/starting empty.*; moved to .*\.bad-\d+$/)]);
      const aside = (errors[0] ?? "").split("moved to ")[1] as string;
      svc.onSounding(raw(6, T0));
      svc.save();
      expect(fs.readFileSync(aside, "utf8")).toBe(bad);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
      fs.rmSync(aside);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("confirmed shoals survive a change of leaf zoom either way", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-livechart-"));
    const file = path.join(dir, "livechart.json");
    const atZoom = (leafZoom: number) =>
      buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom });
    const errors: string[] = [];
    const deps = { setNote: () => Promise.resolve(), error: (m: string) => errors.push(m) };
    const confirm = (leafZoom: number) => {
      const svc = new LivechartService(atZoom(leafZoom), CONFIG, file, failOnError);
      for (const start of [T0, T0 + 15 * 60_000]) {
        for (let k = 0; k < 3; k++) {
          svc.onSounding(raw(5.2, start + k * 1000));
        }
      }
      expect(svc.discrepancies()).toHaveLength(1);
      svc.save();
    };
    const shoalDepth = (s: ReturnType<typeof atZoom>, p: LonLat = SHOAL) =>
      minDepthOver(s, footprintGeom([p])).dMin;

    // z18 cells onto z16: the z16 cell holding the shoal takes its depth.
    confirm(18);
    const coarse = atZoom(16);
    const onCoarse = new LivechartService(coarse, CONFIG, file, deps);
    expect(shoalDepth(coarse)).toBeLessThan(5.3);
    expect(errors).toEqual([
      expect.stringMatching(/was saved at zoom 18: its 1 cells are dropped/)
    ]);
    // Saved at z16 without cells, it loads whole and survives a rebuilt index of that zoom.
    onCoarse.save();
    const again = atZoom(16);
    const reloaded = new LivechartService(again, CONFIG, file, failOnError);
    expect(shoalDepth(again)).toBeLessThan(5.3);
    const rebuilt = atZoom(16);
    reloaded.rebind(rebuilt);
    expect(shoalDepth(rebuilt)).toBeLessThan(5.3);

    // z16 cells onto z18: every z18 cell inside the shoal's z16 cell takes its depth.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    confirm(16);
    const fine = atZoom(18);
    new LivechartService(fine, CONFIG, file, deps);
    expect(shoalDepth(fine)).toBeLessThan(5.3);
    expect(fine.adjustments.size).toBe(16);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the CSB export gives depths below the transducer, with its depth as the draft", () => {
    const svc = new LivechartService(
      store(),
      {
        ...CONFIG,
        writeNotes: false,
        source: { ...SURFACE, path: "environment.depth.belowTransducer", transducerDepth: 0.5 }
      },
      path.join(os.tmpdir(), "never-written.json"),
      failOnError
    );
    svc.onSounding(raw(4.2, T0));
    const csb = svc.csb() as {
      features: { properties: { depth: number } }[];
      properties: { platform: { sensors: { draft: number }[] } };
    };
    expect(csb.features[0]?.properties.depth).toBe(4.2);
    expect(csb.properties.platform.sensors[0]?.draft).toBe(0.5);
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
          fc.tuple(fraction, fraction, uniform(0.5, 25), fc.integer({ min: 0, max: 7200 })),
          { maxLength: 60 }
        ),
        fc.array(fc.tuple(fraction, fraction), { minLength: 1, maxLength: 8 }),
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
