import fc from "fast-check";
import { createHash } from "crypto";
import { UkcTileChanges } from "../../src/api/ukc-tile-changes";
import { parseConfig } from "../../src/config";
import { UkcTileCache } from "../../src/engine/ukc-tile-cache";
import { ceil32, floor32, geometryBytes, tileGeometry } from "../../src/engine/ukc-tile-geometry";
import type { UkcTileInput } from "../../src/engine/ukc-tiles";
import { DETAIL_ZOOMS, ukcTile } from "../../src/engine/ukc-tiles";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import { tileAt, tileKey, toMercator } from "../../src/foundation/geo";
import type { LonLat } from "../../src/foundation/geo";
import type { WaterLevel } from "../../src/model/uncertainty";
import type { QueryServiceDeps } from "../../src/query-service";
import { ukcTileReply } from "../../src/query-service";
import type { ChartIndex } from "../../src/spatial/chart-index";
import type { NodeStore } from "../../src/spatial/node-store";
import { FLAGS } from "../../src/spatial/node-store";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { uniform } from "../helpers/arbitraries";
import { referenceUkcTile } from "../helpers/reference-ukc-tiles";
import { area, coverage, quality } from "../helpers/synthetic";

/**
 * The encoded UKC tiles kept by UkcTileCache: a tile is served from them only
 * while it is the tile drawn now, and the geometry columns that were narrowed
 * to keep more tiles never lower a class.
 */

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

const SPOTS: LonLat[] = [
  [22.03, 60.0155],
  [22.013, 60.007],
  [22.045, 60.02],
  [22.0, 60.0]
];

function tileOf(z: number, [lon, lat]: LonLat): { z: number; x: number; y: number } {
  const [mx, my] = toMercator(lon, lat);
  return { z, ...tileAt(z, mx, my) };
}

const sha = (b: Uint8Array): string => createHash("sha1").update(b).digest("hex").slice(0, 12);

/** What the tile route reads from: each of these can be changed between requests. */
interface Scene {
  store: NodeStore;
  draft: number;
  level: WaterLevel;
  config: ReturnType<typeof parseConfig>;
  wave: number | undefined;
}

const scene = (store: NodeStore): Scene => ({
  store,
  draft: 4.6,
  level: { h: 0, sigma: 0.1, source: "manual" },
  config: parseConfig({}),
  wave: undefined
});

const depsOf = (s: Scene, tileCache?: UkcTileCache): QueryServiceDeps => ({
  get index() {
    return { pyramid: s.store } as unknown as ChartIndex;
  },
  indexReason: undefined,
  get config() {
    return s.config;
  },
  vessel: () => ({ draft: s.draft, length: 12, beam: 4 }),
  levelRegimes: () => ({ inside: s.level }),
  waveHeight: () => s.wave,
  tileChanges: new UkcTileChanges(),
  ...(tileCache ? { tileCache } : {})
});

const body = (d: QueryServiceDeps, z: number, x: number, y: number): Uint8Array =>
  ukcTileReply(z, x, y, d).body as Uint8Array;

describe("encoded tiles in the cache", () => {
  const T = tileOf(14, SPOTS[0] as LonLat);
  const at = (d: QueryServiceDeps) => body(d, T.z, T.x, T.y);

  test("the same request is served the bytes drawn before, not drawn again", () => {
    const s = scene(banks());
    const cache = new UkcTileCache();
    const d = depsOf(s, cache);
    const first = at(d);
    expect(at(d)).toBe(first);
    expect(cache.drawnSize).toBe(1);
  });

  test("a threshold within the tile's range is served from the cache and is the tile drawn afresh", () => {
    const s = scene(banks());
    const cache = new UkcTileCache();
    const d = depsOf(s, cache);
    const plain = depsOf(s);
    const first = at(d);
    let kept = 0;
    // A 15 m basin: P is far from every level over a wide range of water levels.
    for (const h of [0.001, -0.002, 0.01, 0.05]) {
      s.level = { ...s.level, h };
      const got = at(d);
      expect(Buffer.from(got).equals(Buffer.from(at(plain)))).toBe(true);
      kept += got === first ? 1 : 0;
    }
    expect(kept).toBeGreaterThan(0);
  });

  test("a tile served from the cache is the uncached one at any water level (property)", () => {
    const s = scene(banks());
    const plain = depsOf(s);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            spot: fc.integer({ min: 0, max: SPOTS.length - 1 }),
            z: fc.constantFrom(12, 14, 16),
            h: uniform(-1, 12),
            sigma: fc.constantFrom(0.05, 0.1, 0.3),
            draft: fc.constantFrom(2, 4.6, 9)
          }),
          { minLength: 2, maxLength: 12 }
        ),
        (steps) => {
          const cache = new UkcTileCache();
          const d = depsOf(s, cache);
          for (const step of steps) {
            s.level = { h: step.h, sigma: step.sigma, source: "manual" };
            s.draft = step.draft;
            const t = tileOf(step.z, SPOTS[step.spot] as LonLat);
            expect(
              Buffer.from(body(d, t.z, t.x, t.y)).equals(Buffer.from(body(plain, t.z, t.x, t.y)))
            ).toBe(true);
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  describe("each input a tile is drawn from draws it afresh when it changes", () => {
    // A change to `edit` leaves the tile as an uncached request draws it, and, for `moves`,
    // not as it was.
    const cases: [string, (s: Scene) => void, boolean][] = [
      ["the draft", (s) => (s.draft = 15.5), true],
      ["the water level", (s) => (s.level = { ...s.level, h: -3 }), true],
      ["the water level's σ", (s) => (s.level = { ...s.level, sigma: 2.5 }), true],
      [
        "the fallback flag",
        (s) => (s.level = { ...s.level, degraded: "fallback", source: "fallback" }),
        true
      ],
      ["the wave height", (s) => (s.wave = 6), true],
      [
        "the alert and warn levels",
        (s) => {
          s.config = parseConfig({
            lookahead: { thresholds: { alert: 0.45, warn: 0.5, alarm: 0.9 } }
          });
        },
        false
      ],
      ["the index", (s) => (s.store = banks(12)), true]
    ];

    test.each(cases)("%s", (_name, edit, moves) => {
      // Draft 13 in 15 m: 2 m of clearance, clear, and the next change to a class.
      const s = { ...scene(banks()), draft: 13 };
      const cache = new UkcTileCache();
      const d = depsOf(s, cache);
      const plain = depsOf(s);
      const before = Buffer.from(at(d));
      expect(Buffer.from(at(plain)).equals(before)).toBe(true);
      edit(s);
      const after = Buffer.from(at(d));
      expect(after.equals(Buffer.from(at(plain)))).toBe(true);
      if (moves) {
        expect(after.equals(before)).toBe(false);
      }
    });

    test("an own sounding in the tile, and one in another tile", () => {
      const s = scene(banks());
      const cache = new UkcTileCache();
      const d = depsOf(s, cache);
      const plain = depsOf(s);
      // Open water at 15 m, 4.6 m draft: clear until a sounding of 1 m lands in the tile.
      const T = tileOf(14, SPOTS[2] as LonLat);
      const at = (deps: QueryServiceDeps) => body(deps, T.z, T.x, T.y);
      const before = at(d);
      const far = tileOf(s.store.adjustZoom, [22.058, 60.029]);
      const cell = {
        dMin: 1,
        sigmaD: 0.05,
        sigmaP: 0,
        flags: FLAGS.LIVECHART_ADJUSTED,
        cellRef: -1
      };
      s.store.adjustments.set(tileKey(far.z, far.x, far.y), cell);
      expect(tileOf(14, [22.058, 60.029])).not.toEqual(T);
      expect(at(d)).toBe(before);
      const near = tileOf(s.store.adjustZoom, SPOTS[2] as LonLat);
      s.store.adjustments.set(tileKey(near.z, near.x, near.y), cell);
      const after = at(d);
      expect(after).not.toBe(before);
      expect(Buffer.from(after).equals(Buffer.from(at(plain)))).toBe(true);
      expect(Buffer.from(after).equals(Buffer.from(before))).toBe(false);
      // The same value written again is a write whose cells compare equal: the bytes stay.
      s.store.adjustments.set(tileKey(near.z, near.x, near.y), cell);
      expect(at(d)).toBe(after);
      s.store.adjustments.clear();
      expect(Buffer.from(at(d)).equals(Buffer.from(before))).toBe(true);
    });
  });

  test("risk levels edited in place after a tile was kept draw it again", () => {
    const store = banks();
    const cache = new UkcTileCache();
    const thresholds = { alert: 0.01, warn: 0.05, alarm: 0.2 };
    const input: UkcTileInput = { threshold: 2, sigmaExtra: 0.1, thresholds, degraded: false };
    cache.keepDrawn(store, T.z, T.x, T.y, input, { lo: 1, hi: 3 }, new Uint8Array(10));
    thresholds.warn = 0.4;
    expect(cache.drawnTile(store, T.z, T.x, T.y, input)).toBeUndefined();
  });

  test("a threshold outside the range of the kept tile draws it again", () => {
    const store = banks();
    const cache = new UkcTileCache();
    const input: UkcTileInput = {
      threshold: 2,
      sigmaExtra: 0.1,
      thresholds: DEFAULT_LOOKAHEAD.thresholds,
      degraded: false
    };
    const kept = cache.keepDrawn(store, T.z, T.x, T.y, input, { lo: 1, hi: 3 }, new Uint8Array(10));
    expect(cache.drawnTile(store, T.z, T.x, T.y, input)).toBe(kept);
    expect(cache.drawnTile(store, T.z, T.x, T.y, { ...input, threshold: 3 })).toBe(kept);
    expect(cache.drawnTile(store, T.z, T.x, T.y, { ...input, threshold: 1 })).toBe(kept);
    for (const other of [
      { ...input, threshold: 3.0001 },
      { ...input, sigmaExtra: 0.11 },
      { ...input, degraded: true },
      { ...input, thresholds: { ...input.thresholds, warn: input.thresholds.warn + 0.01 } },
      { ...input, thresholds: { ...input.thresholds, alert: input.thresholds.alert + 0.01 } }
    ]) {
      expect(cache.drawnTile(store, T.z, T.x, T.y, other)).toBeUndefined();
    }
    // A miss took the entry out; the cache holds nothing for the tile until it is kept again.
    expect(cache.drawnTile(store, T.z, T.x, T.y, input)).toBeUndefined();
    expect(cache.drawnSize).toBe(0);
  });

  test("another store, even one with the same tiles, empties it", () => {
    const store = banks();
    const cache = new UkcTileCache();
    const input: UkcTileInput = {
      threshold: 2,
      sigmaExtra: 0.1,
      thresholds: DEFAULT_LOOKAHEAD.thresholds,
      degraded: false
    };
    cache.keepDrawn(
      store,
      T.z,
      T.x,
      T.y,
      input,
      { lo: -Infinity, hi: Infinity },
      new Uint8Array(1)
    );
    expect(cache.drawnTile(banks(), T.z, T.x, T.y, input)).toBeUndefined();
    expect(cache.drawnSize).toBe(0);
  });

  describe("the byte budget", () => {
    const store = banks();
    const input: UkcTileInput = {
      threshold: 2,
      sigmaExtra: 0.1,
      thresholds: DEFAULT_LOOKAHEAD.thresholds,
      degraded: false
    };
    const keep = (cache: UkcTileCache, x: number, size: number) =>
      cache.keepDrawn(
        store,
        14,
        x,
        0,
        input,
        { lo: -Infinity, hi: Infinity },
        new Uint8Array(size)
      );

    test("holds at most its budget, dropping the least recently used first", () => {
      // Each entry costs twice its body (room for its gzip) and 512.
      const cost = (size: number) => 2 * size + 512;
      const cache = new UkcTileCache(1, 3 * cost(1000));
      for (const x of [1, 2, 3]) {
        keep(cache, x, 1000);
      }
      expect(cache.drawnSize).toBe(3);
      expect(cache.drawnTile(store, 14, 1, 0, input)).toBeDefined();
      keep(cache, 4, 1000);
      expect(cache.drawnBytes).toBeLessThanOrEqual(3 * cost(1000));
      expect(cache.drawnSize).toBe(3);
      expect(cache.drawnTile(store, 14, 2, 0, input)).toBeUndefined();
      for (const x of [1, 3, 4]) {
        expect(cache.drawnTile(store, 14, x, 0, input)).toBeDefined();
      }
    });

    test("never exceeds its budget over any sequence of sizes, and skips a tile larger than it", () => {
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 60 }), (sizes) => {
          const cache = new UkcTileCache(1, 6000);
          sizes.forEach((size, i) => {
            keep(cache, i % 17, size);
            expect(cache.drawnBytes).toBeLessThanOrEqual(6000);
          });
          const big = new UkcTileCache(1, 6000);
          keep(big, 1, 6000);
          expect(big.drawnSize).toBe(0);
        }),
        { numRuns: 50 }
      );
    });

    test("a tile drawn from the index costs more than its body, so the budget bounds the memory", () => {
      const cache = new UkcTileCache();
      const d = depsOf(scene(store), cache);
      const b = body(d, 14, T.x, T.y);
      expect(cache.drawnBytes).toBeGreaterThan(b.length);
    });
  });
});

describe("narrowed geometry columns", () => {
  test("floor32 and ceil32 bracket a value by one float32 step at most (property)", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }), (v) => {
        const lo = floor32(v);
        const hi = ceil32(v);
        const exact = Math.fround(lo) === lo && Math.fround(hi) === hi;
        const ok = lo <= v && hi >= v;
        // Within the spacing of float32 at the value: never a whole step more than needed.
        const tight =
          Math.abs(v) < 1e-30 ||
          (v - lo <= Math.abs(v) * 2 ** -23 && hi - v <= Math.abs(v) * 2 ** -23);
        return exact && ok && tight;
      }),
      { numRuns: 5000 }
    );
  });

  test("a value that is a float32 stays, and the ends at zero hold", () => {
    for (const v of [0, -0, 1, -1, 12, 1024, 0.5, 2 ** -30, -(2 ** -30)]) {
      expect(floor32(v)).toBe(v);
      expect(ceil32(v)).toBe(v);
    }
    expect(floor32(1e-50)).toBeLessThanOrEqual(1e-50);
    expect(ceil32(-1e-50)).toBeGreaterThanOrEqual(-1e-50);
    expect(floor32(-1e-50)).toBeLessThanOrEqual(-1e-50);
    expect(ceil32(1e-50)).toBeGreaterThanOrEqual(1e-50);
  });

  test("the geometry's source columns agree: indexes in range, one scale, edges in order", () => {
    const store = banks();
    for (const z of [12, 14, 16, 18]) {
      for (const spot of SPOTS) {
        const t = tileOf(z, spot);
        const g = tileGeometry(store, t.z, t.x, t.y);
        const n = g.sourceKind.length;
        expect(g.sourceSigma.length).toBe(n);
        expect(g.sourceRect.length).toBe(4 * n);
        expect(g.sourceRect).toBeInstanceOf(Float32Array);
        expect(typeof g.sourceScale).toBe("number");
        expect(n === 0 || g.sourceScale > 0).toBe(true);
        expect(new Set(g.sigmas).size).toBe(g.sigmas.length);
        const inRange =
          g.sourceKind.every((k) => k < g.dMin.length) &&
          g.sourceSigma.every((k) => k < g.sigmas.length) &&
          g.cellKind.every((k) => k < g.dMin.length);
        expect(inRange).toBe(true);
        const ordered = Array.from({ length: n }, (_, i) => i).every(
          (i) =>
            (g.sourceRect[4 * i] as number) <= (g.sourceRect[4 * i + 2] as number) &&
            (g.sourceRect[4 * i + 1] as number) <= (g.sourceRect[4 * i + 3] as number)
        );
        expect(ordered).toBe(true);
        expect(geometryBytes(g)).toBeGreaterThan(0);
        // 16 bytes of edges and two 16-bit indexes a source, where it was 56 bytes of float64.
        const perSource =
          g.sourceRect.byteLength + g.sourceKind.byteLength + g.sourceSigma.byteLength;
        expect(perSource).toBe(20 * n);
      }
    }
  });

  /** Severity per slot of a tile's rectangles: unverified is above caution, land is none. */
  const SEVERITY: Record<string, number> = {
    land: -1,
    clear: 0,
    caution: 1,
    unverified: 2,
    danger: 3
  };
  const EXTENT = 4096;
  const SLOTS = 2 ** DETAIL_ZOOMS;
  function slotSeverity(rects: ReturnType<typeof ukcTile>): Int8Array {
    const out = new Int8Array(SLOTS * SLOTS).fill(-2);
    const step = EXTENT / SLOTS;
    for (const r of rects) {
      for (let j = Math.floor(r.y0 / step); j < Math.ceil(r.y1 / step); j++) {
        for (let i = Math.floor(r.x0 / step); i < Math.ceil(r.x1 / step); i++) {
          out[j * SLOTS + i] = Math.max(out[j * SLOTS + i] as number, SEVERITY[r.class] as number);
        }
      }
    }
    return out;
  }

  test("a tile drawn from float32 edges is nowhere less severe than the float64 drawing (property)", () => {
    const stores = [banks(), banks(12)];
    const arb = fc.record({
      s: fc.integer({ min: 0, max: 1 }),
      z: fc.constantFrom(11, 12, 14, 16, 18),
      spot: fc.integer({ min: 0, max: SPOTS.length - 1 }),
      input: fc.record({
        threshold: uniform(-1, 16),
        sigmaExtra: fc.oneof(fc.constant(0), uniform(0, 1.5)),
        thresholds: fc.constantFrom(DEFAULT_LOOKAHEAD.thresholds, {
          alert: 0.5,
          warn: 0.62,
          alarm: 0.9
        }),
        degraded: fc.boolean()
      })
    });
    fc.assert(
      fc.property(arb, ({ s, z, spot, input }) => {
        const store = stores[s] as NodeStore;
        const t = tileOf(z, SPOTS[spot] as LonLat);
        const drawn = slotSeverity(ukcTile(store, t.z, t.x, t.y, EXTENT, input));
        const exact = slotSeverity(referenceUkcTile(store, t.z, t.x, t.y, EXTENT, input, true));
        return drawn.every((v, i) => v >= (exact[i] as number));
      }),
      { numRuns: 80 }
    );
  });
});

describe("fixture tiles are the bytes the float64 columns drew", () => {
  // sha1 of each served tile, drawn by the code before the columns were narrowed.
  const GOLDEN: Record<string, string> = {
    "draft 4.6 z11 spot0": "35733d267667",
    "draft 4.6 z11 spot1": "35733d267667",
    "draft 4.6 z11 spot2": "35733d267667",
    "draft 4.6 z11 spot3": "35733d267667",
    "draft 4.6 z12 spot0": "2a837be07e28",
    "draft 4.6 z12 spot1": "2a837be07e28",
    "draft 4.6 z12 spot2": "2a837be07e28",
    "draft 4.6 z12 spot3": "2a837be07e28",
    "draft 4.6 z13 spot0": "81edea8185dd",
    "draft 4.6 z13 spot1": "86288498c13c",
    "draft 4.6 z13 spot2": "81edea8185dd",
    "draft 4.6 z13 spot3": "86288498c13c",
    "draft 4.6 z14 spot0": "d3f04c05d3f8",
    "draft 4.6 z14 spot1": "cb002c4c8f2a",
    "draft 4.6 z14 spot2": "a81e99dee117",
    "draft 4.6 z14 spot3": "cb002c4c8f2a",
    "draft 4.6 z16 spot0": "9e2ad6070127",
    "draft 4.6 z16 spot1": "005c84d5a9b4",
    "draft 4.6 z16 spot2": "afda15b6fd67",
    "draft 4.6 z16 spot3": "82ee289810a6",
    "draft 4.6 z18 spot0": "af32cacd19d0",
    "draft 4.6 z18 spot1": "af32cacd19d0",
    "draft 4.6 z18 spot2": "afda15b6fd67",
    "draft 4.6 z18 spot3": "9986bbd80cf4",
    "draft 13 z11 spot0": "b676a7e8875b",
    "draft 13 z11 spot1": "b676a7e8875b",
    "draft 13 z11 spot2": "b676a7e8875b",
    "draft 13 z11 spot3": "b676a7e8875b",
    "draft 13 z12 spot0": "b4db3f37e29b",
    "draft 13 z12 spot1": "b4db3f37e29b",
    "draft 13 z12 spot2": "b4db3f37e29b",
    "draft 13 z12 spot3": "b4db3f37e29b",
    "draft 13 z13 spot0": "9589e039b177",
    "draft 13 z13 spot1": "be24bfd02216",
    "draft 13 z13 spot2": "9589e039b177",
    "draft 13 z13 spot3": "be24bfd02216",
    "draft 13 z14 spot0": "d3f04c05d3f8",
    "draft 13 z14 spot1": "4913136c2d84",
    "draft 13 z14 spot2": "9342cb45ffa8",
    "draft 13 z14 spot3": "4913136c2d84",
    "draft 13 z16 spot0": "9e2ad6070127",
    "draft 13 z16 spot1": "005c84d5a9b4",
    "draft 13 z16 spot2": "afda15b6fd67",
    "draft 13 z16 spot3": "f728188d1b1f",
    "draft 13 z18 spot0": "af32cacd19d0",
    "draft 13 z18 spot1": "af32cacd19d0",
    "draft 13 z18 spot2": "afda15b6fd67",
    "draft 13 z18 spot3": "af32cacd19d0",
    "draft 2 σ 0.5 z11 spot0": "065cd2158dfc",
    "draft 2 σ 0.5 z11 spot1": "065cd2158dfc",
    "draft 2 σ 0.5 z11 spot2": "065cd2158dfc",
    "draft 2 σ 0.5 z11 spot3": "065cd2158dfc",
    "draft 2 σ 0.5 z12 spot0": "67fd93684faa",
    "draft 2 σ 0.5 z12 spot1": "67fd93684faa",
    "draft 2 σ 0.5 z12 spot2": "67fd93684faa",
    "draft 2 σ 0.5 z12 spot3": "67fd93684faa",
    "draft 2 σ 0.5 z13 spot0": "2d65a275c6b4",
    "draft 2 σ 0.5 z13 spot1": "438be74a6275",
    "draft 2 σ 0.5 z13 spot2": "2d65a275c6b4",
    "draft 2 σ 0.5 z13 spot3": "438be74a6275",
    "draft 2 σ 0.5 z14 spot0": "d3f04c05d3f8",
    "draft 2 σ 0.5 z14 spot1": "6d8c4cbd9bd6",
    "draft 2 σ 0.5 z14 spot2": "a81e99dee117",
    "draft 2 σ 0.5 z14 spot3": "6d8c4cbd9bd6",
    "draft 2 σ 0.5 z16 spot0": "9e2ad6070127",
    "draft 2 σ 0.5 z16 spot1": "fbc51ad7958d",
    "draft 2 σ 0.5 z16 spot2": "afda15b6fd67",
    "draft 2 σ 0.5 z16 spot3": "82ee289810a6",
    "draft 2 σ 0.5 z18 spot0": "af32cacd19d0",
    "draft 2 σ 0.5 z18 spot1": "afda15b6fd67",
    "draft 2 σ 0.5 z18 spot2": "afda15b6fd67",
    "draft 2 σ 0.5 z18 spot3": "9986bbd80cf4",
    "fallback z11 spot0": "3e726640b0d8",
    "fallback z11 spot1": "3e726640b0d8",
    "fallback z11 spot2": "3e726640b0d8",
    "fallback z11 spot3": "3e726640b0d8",
    "fallback z12 spot0": "82144b950c74",
    "fallback z12 spot1": "82144b950c74",
    "fallback z12 spot2": "82144b950c74",
    "fallback z12 spot3": "82144b950c74",
    "fallback z13 spot0": "fbf3fac2157c",
    "fallback z13 spot1": "36329711ec75",
    "fallback z13 spot2": "fbf3fac2157c",
    "fallback z13 spot3": "36329711ec75",
    "fallback z14 spot0": "c67fa689a89d",
    "fallback z14 spot1": "8a27d7e5e73c",
    "fallback z14 spot2": "9bc7af739d9d",
    "fallback z14 spot3": "8a27d7e5e73c",
    "fallback z16 spot0": "aac56e18c4b3",
    "fallback z16 spot1": "005c84d5a9b4",
    "fallback z16 spot2": "9986bbd80cf4",
    "fallback z16 spot3": "82ee289810a6",
    "fallback z18 spot0": "af32cacd19d0",
    "fallback z18 spot1": "af32cacd19d0",
    "fallback z18 spot2": "9986bbd80cf4",
    "fallback z18 spot3": "9986bbd80cf4"
  };

  const tiles = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const s = scene(banks());
    const d = depsOf(s, new UkcTileCache());
    const variants: [string, (s: Scene) => void][] = [
      ["draft 4.6", () => undefined],
      ["draft 13", (v) => (v.draft = 13)],
      ["draft 2 σ 0.5", (v) => ((v.draft = 2), (v.level = { ...v.level, sigma: 0.5 }))],
      ["fallback", (v) => (v.level = { ...v.level, degraded: "fallback", source: "fallback" })]
    ];
    for (const [name, edit] of variants) {
      Object.assign(s, scene(s.store));
      edit(s);
      for (const z of [11, 12, 13, 14, 16, 18]) {
        SPOTS.forEach((spot, i) => {
          const t = tileOf(z, spot);
          out[`${name} z${z} spot${i}`] = sha(body(d, t.z, t.x, t.y));
        });
      }
    }
    return out;
  };

  test("each equals its golden hash", () => {
    const got = tiles();
    if (process.env.UKC_GOLDEN) {
      process.stdout.write(`GOLDEN ${JSON.stringify(got)}\n`);
    }
    expect(got).toEqual(GOLDEN);
  });
});
