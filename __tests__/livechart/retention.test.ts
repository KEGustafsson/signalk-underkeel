import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import type { LonLat } from "../../src/foundation/geo";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import type { CellPosterior } from "../../src/livechart/posterior";
import {
  isDiscrepancy,
  isProtectedMark,
  MIN_PASSES,
  MIN_SAMPLES,
  noPrior,
  Posteriors,
  PROTECT_Z,
  rebasePrior
} from "../../src/livechart/posterior";
import type { Sounding } from "../../src/livechart/soundings";
import { FLAGS } from "../../src/spatial/node-store";
import type { NodeStore } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { uniform } from "../helpers/arbitraries";
import { basin } from "../helpers/synthetic";

/**
 * The living chart's retention bound (plan §4.13): past the cap the cells last sounded longest
 * ago are dropped, never one with an adjustment or one waiting for its block. A shoal still
 * gathering its evidence is bounded apart from the other cells, so it is kept among them even
 * after the index box has moved away from it.
 */

const T0 = 1_800_000_000_000;
const CONFIG: LivechartConfig = {
  source: { path: "environment.depth.belowSurface", transducerDepth: 0, forward: 0, starboard: 0 },
  writeNotes: false,
  csb: { id: "anon", idType: "Other" }
};
const SHOAL: LonLat = [22.05, 60.05];

const chart = (): NodeStore =>
  buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 });
/** Charts somewhere else: no coverage at the shoal, as after the index box moved away. */
const away = (): NodeStore =>
  buildPyramid(basin([23.0, 61.0, 23.1, 61.1], 8), { minZoom: 12, leafZoom: 18 });

/** Cell `i` of a row east of the shoal, each in its own z18 cell. */
const other = (i: number): LonLat => [22.0 + 0.002 * i, 60.02];

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function service(store: NodeStore, maxCells: number, file?: string) {
  const t = { now: T0 };
  if (!file) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-retention-"));
    dirs.push(dir);
    file = path.join(dir, "livechart.json");
  }
  const svc = new LivechartService(store, CONFIG, file, {
    setNote: () => Promise.resolve(),
    error: (m) => {
      throw new Error(m);
    },
    now: () => t.now,
    maxCells
  });
  const sound = (depth: number, position: LonLat = SHOAL) => {
    t.now += 1000;
    svc.onSounding({
      depth,
      at: t.now,
      position,
      positionAt: t.now,
      hdop: 0.9,
      methodQuality: "GNSS Fix",
      waterLevel: { h: 0, sigma: 0.05, source: "manual" }
    });
    svc.flush();
  };
  return { t, svc, sound, file };
}

const posteriorsOf = (svc: LivechartService) =>
  (svc as unknown as { posteriors: Posteriors }).posteriors;

const ADJUSTED = { dMin: 1, sigmaD: 0.1, sigmaP: 0, flags: FLAGS.LIVECHART_ADJUSTED, cellRef: 0 };

describe("living-chart retention", () => {
  const store = chart();

  test("a prune keeps adjusted and waiting cells and the newest shoals and other cells", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            lastAt: fc.integer({ min: 0, max: 30 }),
            adjusted: fc.boolean(),
            unsettled: fc.boolean(),
            peakZ: fc.option(uniform(-3, 3), { nil: undefined }),
            samples: fc.integer({ min: 1, max: MIN_SAMPLES + 2 }),
            passes: fc.integer({ min: 1, max: MIN_PASSES + 1 })
          }),
          { maxLength: 60 }
        ),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (cells, max, cut) => {
          const low = Math.min(cut, max);
          store.adjustments.clear();
          const p = new Posteriors(store);
          cells.forEach((c, key) => {
            p.cells.set(key, {
              z: 18,
              x: key,
              y: 0,
              chartDepth: 8,
              chartSigma: 0.3,
              cellRef: 0,
              mean: 8,
              sigma: 0.3,
              samples: c.samples,
              passes: c.passes,
              lastAt: c.lastAt,
              ...(c.peakZ === undefined ? {} : { peakZ: c.peakZ })
            });
            if (c.adjusted) {
              store.adjustments.set(key, ADJUSTED);
            }
            if (c.unsettled) {
              p.unsettled.add(key);
            }
          });
          const kept = (key: number) => store.adjustments.has(key) || p.unsettled.has(key);
          const shoal = (c: (typeof cells)[number]) =>
            (c.peakZ ?? -Infinity) >= PROTECT_Z &&
            (c.samples < MIN_SAMPLES || c.passes < MIN_PASSES);
          const kinds = [true, false].map((isShoal) =>
            cells
              .map((c, key) => [c.lastAt, key, shoal(c)] as const)
              .filter(([, key, s]) => !kept(key) && s === isShoal)
              .sort((a, b) => a[0] - b[0] || a[1] - b[1])
              .map(([, key]) => key)
          );
          const before = p.cells.size;
          const dropped = p.prune(max, low);
          expect(before - p.cells.size).toBe(dropped);
          const left = new Set(p.cells.keys());
          const expected = cells
            .map((_c, key) => key)
            .filter(
              (key) =>
                kept(key) ||
                kinds.some(
                  (kind) =>
                    kind.includes(key) &&
                    (cells.length <= max ||
                      kind.length <= max ||
                      kind.indexOf(key) >= kind.length - low)
                )
            );
          expect([...left].sort((a, b) => a - b)).toEqual(expected);
        }
      ),
      { numRuns: 200 }
    );
    store.adjustments.clear();
  });

  const sounding = (depth: number, sigma: number, at: number): Sounding => ({
    position: SHOAL,
    at,
    belowSurface: depth,
    depth,
    sigma
  });

  test("a discrepancy is always protected, and a cell's mark is never lowered", () => {
    type Step =
      | { rebase: false; depth: number; sigma: number; dt: number }
      | {
          rebase: true;
          depth: number | null;
          sigma: number;
        };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        rebase: fc.constant(false as const),
        depth: uniform(3, 12),
        sigma: uniform(0.05, 1),
        dt: fc.integer({ min: 1000, max: 20 * 60_000 })
      }),
      fc.record({
        rebase: fc.constant(true as const),
        depth: fc.option(uniform(3, 12), { nil: null }),
        sigma: uniform(0.05, 1)
      })
    );
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
        const p = new Posteriors(store);
        let at = T0;
        let peak = -Infinity;
        for (const s of steps) {
          let c: CellPosterior | undefined;
          if (!s.rebase) {
            at += s.dt;
            c = p.add(sounding(s.depth, s.sigma, at));
            if (isDiscrepancy(c)) {
              expect(isProtectedMark(c)).toBe(true);
            }
          } else {
            const old = [...p.cells.entries()][0];
            if (!old) {
              continue;
            }
            const prior =
              s.depth === null ? noPrior() : { depth: s.depth, sigma: s.sigma, cellRef: 0 };
            c = rebasePrior(old[1], prior);
            p.cells.set(old[0], c);
          }
          expect(c.peakZ ?? -Infinity).toBeGreaterThanOrEqual(peak);
          peak = c.peakZ ?? -Infinity;
        }
      }),
      { numRuns: 200 }
    );
  });

  test("a passage that reads every cell shallower keeps no more shoals than the cap", () => {
    const h = service(chart(), 20);
    // 45 cells of one pass, all on the 8 m chart, each read 2 m shallower three times.
    for (let i = 0; i < 45; i++) {
      for (let k = 0; k < 3; k++) {
        h.sound(6, other(i));
      }
    }
    expect(h.svc.discrepancies()).toEqual([]);
    expect(h.svc.status().dropped).toBeGreaterThan(0);
    expect(h.svc.status().cells).toBeLessThanOrEqual(20);
  });

  test("a single shoal pass stays protected after the index box moves away from it", () => {
    const h = service(chart(), 20);
    // One pass of three readings, 2 m shallower than the 8 m chart: not yet a discrepancy.
    for (let k = 0; k < 3; k++) {
      h.sound(6);
    }
    expect(h.svc.discrepancies()).toEqual([]);
    // The box moves away: the cell's prior is no chart at all.
    h.svc.rebind(away());
    for (let i = 0; i < 60; i++) {
      h.sound(8.2, other(i));
    }
    expect(h.svc.status().dropped).toBeGreaterThan(0);
    expect(h.svc.status().cells).toBeLessThanOrEqual(21);
    // Back over the shoal on its chart, a second pass confirms it.
    h.svc.rebind(chart());
    h.t.now += 20 * 60_000;
    for (let k = 0; k < 2; k++) {
      h.sound(6);
    }
    expect(h.svc.discrepancies()).toHaveLength(1);
    expect(h.svc.discrepancies()[0]).toMatchObject({ samples: 5, passes: 2, charted: 8 });
  });

  test("dropping cells leaves a confirmed shoal whole, and a reload restores what was kept", async () => {
    const pyramid = chart();
    const h = service(pyramid, 20);
    // Two passes over a 5.2 m shoal on the 8 m chart.
    for (const gap of [0, 15 * 60_000]) {
      h.t.now += gap;
      for (let k = 0; k < 3; k++) {
        h.sound(5.2);
      }
    }
    const shoal = minDepthOver(pyramid, footprintGeom([SHOAL]));
    expect(shoal.flags & FLAGS.LIVECHART_ADJUSTED).toBeTruthy();
    const discrepancy = h.svc.discrepancies();
    const adjustments = [...pyramid.adjustments];
    const posterior = [...posteriorsOf(h.svc).cells.values()][0];
    for (let i = 0; i < 60; i++) {
      h.sound(8.2, other(i));
    }
    expect(h.svc.status().dropped).toBeGreaterThan(0);
    expect(h.svc.status().cells).toBeLessThanOrEqual(21);
    expect(h.svc.discrepancies()).toEqual(discrepancy);
    expect([...pyramid.adjustments]).toEqual(adjustments);
    expect(minDepthOver(pyramid, footprintGeom([SHOAL]))).toEqual(shoal);
    expect(posteriorsOf(h.svc).cells.get(adjustments[0]?.[0] ?? -1)).toEqual(posterior);
    // The first state save after the prune rewrites cells.ndjson with the cells kept.
    h.t.now += 10 * 60_000;
    h.svc.flush();
    const lines = fs
      .readFileSync(path.join(path.dirname(h.file), "cells.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(h.svc.status().cells as number);
    h.svc.stop();

    const kept = new Map(posteriorsOf(h.svc).cells);
    const again = service(chart(), 20, h.file);
    await again.svc.whenSettled();
    const restored = posteriorsOf(again.svc).cells;
    expect([...restored.keys()].sort()).toEqual([...kept.keys()].sort());
    for (const [key, c] of kept) {
      expect(restored.get(key)?.mean).toBeCloseTo(c.mean, 9);
      expect(restored.get(key)?.sigma).toBeCloseTo(c.sigma, 9);
    }
  });

  test("a cell dropped and sounded again during a prepared rebind keeps its new sounding", async () => {
    const h = service(chart(), 10);
    // The first cell, a single deep reading: the oldest, so the first dropped.
    h.sound(9, other(0));
    for (let i = 1; i < 10; i++) {
      h.sound(8.2, other(i));
    }
    const first = posteriorsOf(h.svc).cells;
    const key = [...first.entries()].find(([, c]) => c.mean > 8.2)?.[0] as number;
    const apply = await h.svc.prepareRebind(
      chart(),
      () => true,
      () => {
        // Two more cells drop the three oldest; the first is sounded again, once.
        h.sound(8.2, other(10));
        h.sound(8.2, other(11));
        expect(first.has(key)).toBe(false);
        h.sound(6.5, other(0));
        return Promise.resolve();
      }
    );
    apply();
    const c = first.get(key);
    expect(c).toMatchObject({ samples: 1, lastAt: h.t.now });
    expect(c?.mean).toBeLessThan(8);
  });

  test("a shoal saved by an earlier version is marked against the prior it was saved with", async () => {
    const h = service(chart(), 20);
    for (let k = 0; k < 3; k++) {
      h.sound(6);
    }
    h.svc.save();
    // The version-1 layout, from before the mark: the cells in livechart.json, without peakZ.
    const dir = path.dirname(h.file);
    const cells = fs
      .readFileSync(path.join(dir, "cells.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ ...(JSON.parse(l) as CellPosterior), peakZ: undefined }));
    const saved = JSON.parse(fs.readFileSync(h.file, "utf8")) as object;
    fs.writeFileSync(h.file, JSON.stringify({ ...saved, cells }));
    fs.rmSync(path.join(dir, "cells.ndjson"));
    // Loaded where the index box no longer charts it.
    const again = service(away(), 20, h.file);
    await again.svc.whenSettled();
    const [c] = [...posteriorsOf(again.svc).cells.values()];
    expect(c?.chartDepth).toBeNaN();
    expect(isProtectedMark(c)).toBe(true);
  });
});
