import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import { UkcTileChanges } from "../../src/api/ukc-tile-changes";
import type { TileChanges } from "../../src/api/ukc-tile-changes";
import { parseConfig } from "../../src/config";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import { geometryBytes, tileGeometry, UkcTileCache } from "../../src/engine/ukc-tile-geometry";
import type { UkcTileInput } from "../../src/engine/ukc-tiles";
import { ukcTile, ukcTileWithRange } from "../../src/engine/ukc-tiles";
import type { UkcTileCache as Cache } from "../../src/engine/ukc-tile-geometry";
import { project, tileAt, tileKey, toMercator } from "../../src/foundation/geo";
import type { LonLat } from "../../src/foundation/geo";
import { LivechartService } from "../../src/livechart-service";
import type { QueryServiceDeps } from "../../src/query-service";
import { ukcTileChangesReply, ukcTileReply } from "../../src/query-service";
import type { ChartIndex } from "../../src/spatial/chart-index";
import type { NodeStore } from "../../src/spatial/node-store";
import { AdjustmentMap, FLAGS } from "../../src/spatial/node-store";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { uniform } from "../helpers/arbitraries";
import { fixtureIndex, ROCK } from "../helpers/fixture-index";
import { referenceUkcTile } from "../helpers/reference-ukc-tiles";
import { area, basin, coverage, quality } from "../helpers/synthetic";

/**
 * RT5: a UKC tile drawn from its cached geometry is the tile the brute-force
 * drawing gives, whatever the inputs, the living-chart cells and the index
 * did in between, and is drawn the same at every threshold of its range.
 */

const EXTENT = 4096;

/**
 * The tile drawn (from `cache` when given) is `want`, by default the brute
 * force, and its range holds: drawn at its ends it is the same.
 */
function expectDrawn(
  store: NodeStore,
  t: { z: number; x: number; y: number },
  extent: number,
  input: UkcTileInput,
  cache?: Cache,
  want = referenceUkcTile(store, t.z, t.x, t.y, extent, input)
): void {
  const got = ukcTileWithRange(store, t.z, t.x, t.y, extent, input, cache);
  expect(got.rects).toEqual(want);
  expect(got.range.lo).toBeLessThanOrEqual(input.threshold);
  expect(got.range.hi).toBeGreaterThanOrEqual(input.threshold);
  const ends = [
    Math.max(got.range.lo, input.threshold - 3),
    Math.min(got.range.hi, input.threshold + 3)
  ];
  for (const threshold of ends) {
    expect(ukcTile(store, t.z, t.x, t.y, extent, { ...input, threshold })).toEqual(want);
  }
}

function tileOf(z: number, lonLat: LonLat) {
  const [mx, my] = toMercator(lonLat[0], lonLat[1]);
  return { z, ...tileAt(z, mx, my) };
}

const BOX = [22.0, 60.0, 22.06, 60.03] as const;

/** CATZOC B over `depth` with a drying patch and a 4 m bank: cells reach 2σP = 100 m. */
const banks = (depth = 15): NodeStore =>
  buildPyramid(
    [
      coverage(BOX),
      quality(BOX, 3),
      area(BOX, depth),
      area([22.028, 60.015, 22.032, 60.016], -1),
      area([22.01, 60.005, 22.016, 60.009], 4)
    ],
    { minZoom: 12, leafZoom: 18 }
  );

/** Places the draws come back to, so the cache is hit as often as missed. */
const SPOTS: LonLat[] = [ROCK, [22.03, 60.0155], [22.013, 60.007], [22.045, 60.02]];

type Step =
  | { kind: "draw"; z: number; spot: number; input: UkcTileInput }
  | { kind: "adjust"; spot: number; dx: number; dy: number; dMin: number; sigmaD: number }
  | { kind: "forget"; spot: number }
  | { kind: "swap" };

const inputArb: fc.Arbitrary<UkcTileInput> = fc.record({
  threshold: uniform(-1, 16),
  sigmaExtra: fc.oneof(fc.constant(0), uniform(0, 1.5)),
  thresholds: fc.constantFrom(DEFAULT_LOOKAHEAD.thresholds, { alert: 0.5, warn: 0.62, alarm: 0.9 }),
  degraded: fc.boolean()
});

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant("draw" as const),
      z: fc.constantFrom(11, 12, 14, 16, 18),
      spot: fc.integer({ min: 0, max: SPOTS.length - 1 }),
      input: inputArb
    })
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("adjust" as const),
      spot: fc.integer({ min: 0, max: SPOTS.length - 1 }),
      dx: fc.integer({ min: -3, max: 3 }),
      dy: fc.integer({ min: -3, max: 3 }),
      dMin: uniform(0.5, 14),
      sigmaD: uniform(0.01, 0.8)
    })
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("forget" as const),
      spot: fc.integer({ min: 0, max: SPOTS.length - 1 })
    })
  },
  { weight: 2, arbitrary: fc.constant({ kind: "swap" as const }) }
);

describe("UKC tile geometry cache", () => {
  // The two bank stores hold the same tiles, so only the store's identity tells them apart.
  const stores = [fixtureIndex().pyramid, banks(), banks(12)];

  test("cached tiles equal uncached ones across adjustments and index swaps", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        expect(stores[1]?.count).toBe(stores[2]?.count);
        stores.forEach((s) => s.adjustments.clear());
        const cache = new UkcTileCache();
        let store = stores[0] as NodeStore;
        for (const step of steps) {
          if (step.kind === "swap") {
            store = stores[(stores.indexOf(store) + 1) % stores.length] as NodeStore;
          } else if (step.kind === "adjust" || step.kind === "forget") {
            const a = tileOf(store.adjustZoom, SPOTS[step.spot] as LonLat);
            if (step.kind === "forget") {
              store.adjustments.delete(tileKey(a.z, a.x, a.y));
            } else {
              store.adjustments.set(tileKey(a.z, a.x + step.dx, a.y + step.dy), {
                dMin: step.dMin,
                sigmaD: step.sigmaD,
                sigmaP: 0,
                flags: FLAGS.LIVECHART_ADJUSTED,
                cellRef: -1
              });
            }
          } else {
            const t = tileOf(step.z, SPOTS[step.spot] as LonLat);
            const want = ukcTile(store, t.z, t.x, t.y, EXTENT, step.input);
            expectDrawn(store, t, EXTENT, step.input, cache, want);
          }
        }
        stores.forEach((s) => s.adjustments.clear());
      }),
      { numRuns: 100 }
    );
  });

  test("tiles equal the brute force over the charts, zooms and inputs (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 1),
        fc.constantFrom(11, 12, 14, 16, 18),
        fc.integer({ min: 0, max: SPOTS.length - 1 }),
        inputArb,
        (s, z, spot, input) => {
          expectDrawn(stores[s] as NodeStore, tileOf(z, SPOTS[spot] as LonLat), EXTENT, input);
        }
      ),
      { numRuns: 40 }
    );
  });

  test("an extent the slots do not divide sorts the rectangles as the brute force", () => {
    const input: UkcTileInput = {
      threshold: 3.6,
      sigmaExtra: 0.3,
      thresholds: DEFAULT_LOOKAHEAD.thresholds,
      degraded: false
    };
    for (const z of [11, 14, 16]) {
      const t = tileOf(z, ROCK);
      const store = stores[0] as NodeStore;
      expectDrawn(store, t, 1000, input);
    }
  });

  test("an own sounding inside a tile redraws it; one elsewhere keeps the cached geometry", () => {
    const store = banks();
    const cache = new UkcTileCache();
    const t = tileOf(14, [22.03, 60.0155]);
    const first = cache.geometry(store, t.z, t.x, t.y);
    expect(cache.geometry(store, t.z, t.x, t.y)).toBe(first);
    const far = tileOf(store.adjustZoom, [22.05, 60.028]);
    const cell = { dMin: 2, sigmaD: 0.05, sigmaP: 0, flags: FLAGS.LIVECHART_ADJUSTED, cellRef: -1 };
    store.adjustments.set(tileKey(far.z, far.x, far.y), cell);
    expect(tileOf(14, [22.05, 60.028])).not.toEqual(t);
    expect(cache.geometry(store, t.z, t.x, t.y)).toBe(first);
    const near = tileOf(store.adjustZoom, [22.035, 60.0155]);
    store.adjustments.set(tileKey(near.z, near.x, near.y), cell);
    const second = cache.geometry(store, t.z, t.x, t.y);
    expect(second).not.toBe(first);
    expect(second).toEqual(tileGeometry(store, t.z, t.x, t.y));
    expect([...second.dMin]).toContain(2);
    // The same value written again is a write: the entry compares its cells and stays.
    store.adjustments.set(tileKey(near.z, near.x, near.y), cell);
    expect(cache.geometry(store, t.z, t.x, t.y)).toBe(second);
    // A rebuilt store with the same tiles and the same writes still empties the cache.
    const other = banks(12);
    expect(other.count).toBe(store.count);
    for (const k of [far, near, near]) {
      other.adjustments.set(tileKey(k.z, k.x, k.y), cell);
    }
    expect(cache.geometry(other, t.z, t.x, t.y)).toEqual(tileGeometry(other, t.z, t.x, t.y));
  });

  test("the cache stays within its byte budget and drops the least recently used tile first", () => {
    const store = stores[0] as NodeStore;
    const tiles = [14, 15, 16].flatMap((z) => {
      const c = tileOf(z, ROCK);
      return [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [z, c.x + dx, c.y + dy] as const));
    });
    const sizeOf = ([z, x, y]: readonly [number, number, number]): number => {
      const one = new UkcTileCache(Infinity);
      one.geometry(store, z, x, y);
      expect(one.bytes).toBeGreaterThan(geometryBytes(tileGeometry(store, z, x, y)));
      return one.bytes;
    };
    const total = tiles.reduce((sum, t) => sum + sizeOf(t), 0);
    const bounded = new UkcTileCache(total / 3);
    for (const [z, x, y] of tiles) {
      bounded.geometry(store, z, x, y);
      expect(bounded.bytes).toBeLessThanOrEqual(total / 3);
    }
    expect(bounded.size).toBeLessThan(tiles.length);
    // d is the smallest of four, so dropping b and c always makes room for it.
    const [d, a, b, c] = tiles.slice(9, 13).sort((p, q) => sizeOf(p) - sizeOf(q)) as [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number]
    ];
    const cache = new UkcTileCache(sizeOf(a) + sizeOf(b) + sizeOf(c));
    const ga = cache.geometry(store, ...a);
    const gb = cache.geometry(store, ...b);
    cache.geometry(store, ...c);
    expect(cache.size).toBe(3);
    expect(cache.geometry(store, ...a)).toBe(ga);
    cache.geometry(store, ...d);
    expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes);
    expect(cache.geometry(store, ...a)).toBe(ga);
    expect(cache.geometry(store, ...b)).not.toBe(gb);
    const tiny = new UkcTileCache(1000);
    tiny.geometry(store, ...a);
    expect([tiny.size, tiny.bytes]).toEqual([0, 0]);
  });

  test("every write to the adjustments moves their revision", () => {
    const m = new AdjustmentMap();
    const v = { dMin: 1, sigmaD: 0, sigmaP: 0, flags: 0, cellRef: -1 };
    const seen = [m.revision];
    m.set(1, v);
    seen.push(m.revision);
    m.set(1, v);
    seen.push(m.revision);
    m.delete(1);
    seen.push(m.revision);
    m.clear();
    seen.push(m.revision);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("UKC tiles served from the cache", () => {
  const T0 = 1_800_000_000_000;
  const SHOAL: LonLat = [22.05, 60.05];
  const WL = { h: 0.2, sigma: 0.05, source: "manual" };

  test("an own sounding changes the tile, lists it, and the cached reply is the uncached one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-tilecache-"));
    const store = buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 });
    const svc = new LivechartService(
      store,
      {
        source: {
          path: "environment.depth.belowSurface",
          transducerDepth: 0,
          forward: 0,
          starboard: 0
        },
        writeNotes: false,
        csb: { id: "anon", idType: "Other" }
      },
      path.join(dir, "livechart.json"),
      {
        setNote: () => Promise.resolve(),
        error: (m) => {
          throw new Error(m);
        }
      }
    );
    const deps = (tileCache?: UkcTileCache): QueryServiceDeps => ({
      index: { pyramid: store } as unknown as ChartIndex,
      indexReason: undefined,
      config: parseConfig({}),
      vessel: () => ({ draft: 4.6, length: 12, beam: 4 }),
      levelRegimes: () => ({ inside: { h: 0, sigma: 0.1, source: "manual" } }),
      waveHeight: () => undefined,
      tileChanges: new UkcTileChanges(),
      ...(tileCache ? { tileCache } : {})
    });
    const plain = deps();
    const cached = deps(new UkcTileCache());
    const tiles = [12, 14, 16, 18].map((z) => tileOf(z, SHOAL));
    const body = (d: QueryServiceDeps, t: { z: number; x: number; y: number }) =>
      Buffer.from(ukcTileReply(t.z, t.x, t.y, d).body as Uint8Array);
    const before = tiles.map((t) => body(cached, t));
    expect(tiles.map((t) => body(plain, t))).toEqual(before);
    const cursor = ukcTileChangesReply({}, cached).body as TileChanges;
    // Two passes over a 5 m shoal charted at 8 m, 15 minutes apart.
    for (const start of [T0, T0 + 15 * 60_000]) {
      for (let k = 0; k < 3; k++) {
        svc.onSounding({
          depth: 5.2,
          at: start + k * 1000,
          position: project(SHOAL, 0, k),
          positionAt: start + k * 1000,
          heading: 0,
          hdop: 0.9,
          methodQuality: "GNSS Fix",
          roll: 0,
          waterLevel: WL
        });
      }
    }
    expect(svc.discrepancies()).toHaveLength(1);
    const listed = ukcTileChangesReply({ epoch: cursor.epoch, rev: String(cursor.rev) }, cached)
      .body as TileChanges;
    const order = (list: number[][]) => list.map((t) => t.join("/")).sort();
    expect(order(listed.tiles)).toEqual(order(tiles.map((t) => [t.z, t.x, t.y])));
    const after = tiles.map((t) => body(cached, t));
    expect(tiles.map((t) => body(plain, t))).toEqual(after);
    after.forEach((b, i) => expect(b.equals(before[i] as Buffer)).toBe(false));
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
