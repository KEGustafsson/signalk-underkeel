import fc from "fast-check";
import { isDeepStrictEqual } from "util";
import type { LonLat } from "../../src/foundation/geo";
import {
  fromMercator,
  project,
  tileAt,
  tileKey,
  tileRect,
  toMercator
} from "../../src/foundation/geo";
import type { Catzoc } from "../../src/ingest/features";
import type { NavState } from "../../src/engine/lookahead";
import { evaluateLookahead } from "../../src/engine/lookahead";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { countedCells } from "../../src/spatial/chart-index";
import { cacheOf } from "../../src/spatial/block-cache";
import type { NodeStore } from "../../src/spatial/node-store";
import { FLAGS } from "../../src/spatial/node-store";
import * as pyramid from "../../src/spatial/pyramid";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { pyramidFromBuffer, serializePyramid } from "../../src/spatial/store";
import { fraction, uniform } from "../helpers/arbitraries";
import { ctx } from "../helpers/engine";
import { fixtureIndex } from "../helpers/fixture-index";
import { referenceGradedWalk } from "../helpers/reference-graded-walk";
import type { Box } from "../helpers/synthetic";
import { area, basin, coverage, land, point, quality } from "../helpers/synthetic";

/**
 * The look-ahead tick's chart walk was sped up (laid-out footprint edges,
 * the shadow's answer kept, a P explained only for the tile that sets it)
 * without changing any answer: with chart position and the survey shadow,
 * every field of every query, visits included, equals the 118913f walk's.
 *
 * A walk over a chart index's pyramid, which knows how many cells its catalogue lists, also
 * leaves out a subtree that can add nothing to what it has found (`stop.ts`, `addsNothing`):
 * every field is the same but `visits`, which is then no more than the reference's.
 */

type Walked = ReturnType<typeof minDepthOver>;

/** `got` with every field `want` has but `visits`, and no more visits than it. */
function sameWithFewerVisits(got: Walked, want: Walked): boolean {
  const { visits: mine, ...rest } = got;
  const { visits: theirs, ...wanted } = want;
  return mine <= theirs && isDeepStrictEqual(rest, wanted);
}

const W = 22.0;
const S = 60.0;
const SPAN_LON = 0.03;
const SPAN_LAT = 0.015;
const DOMAIN: Box = [W, S, W + SPAN_LON, S + SPAN_LAT];

const boxIn = fc
  .tuple(fraction, fraction, uniform(0.01, 0.4), uniform(0.01, 0.4))
  .map(([x, y, w, h]): Box => {
    const lon = W + x * SPAN_LON * 0.9;
    const lat = S + y * SPAN_LAT * 0.9;
    return [lon, lat, lon + w * SPAN_LON * 0.3, lat + h * SPAN_LAT * 0.3];
  });

const chartArb = fc.record({
  areas: fc.array(fc.tuple(boxIn, uniform(-2, 25)), { maxLength: 4 }),
  lands: fc.array(boxIn, { maxLength: 2 }),
  rocks: fc.array(fc.tuple(fraction, fraction, uniform(0, 10)), { maxLength: 6 }),
  /** Every CATZOC, so tiles beyond the buffer are placed by many σ and shadowed by some. */
  zones: fc.array(fc.tuple(boxIn, fc.integer({ min: 1, max: 6 })), { minLength: 1, maxLength: 4 }),
  /** CATZOC of the whole domain under the zones, so most footprints lie in assessed water. */
  base: fc.integer({ min: 1, max: 6 }),
  gap: fc.boolean(),
  adjust: fc.array(fc.tuple(fraction, fraction, uniform(0, 8)), { maxLength: 2 })
});

type Chart = typeof chartArb extends fc.Arbitrary<infer T> ? T : never;

function storeOf(c: Chart): NodeStore {
  const covered: Box = c.gap ? [W, S, W + SPAN_LON * 0.7, S + SPAN_LAT] : DOMAIN;
  const store = buildPyramid(
    [
      ...basin(covered, 20),
      ...c.areas.map(([b, d]) => area(b, d)),
      ...c.lands.map((b) => land(b)),
      ...c.rocks.map(([x, y, d]) => point(W + x * SPAN_LON, S + y * SPAN_LAT, d)),
      quality(DOMAIN, c.base as Catzoc),
      ...c.zones.map(([b, z]) => quality(b, z as Catzoc)),
      coverage(covered)
    ],
    { minZoom: 12, leafZoom: 18 }
  );
  for (const [x, y, d] of c.adjust) {
    const m = toMercator(W + x * SPAN_LON, S + y * SPAN_LAT);
    const t = tileAt(store.adjustZoom, m[0], m[1]);
    store.adjustments.set(tileKey(store.adjustZoom, t.x, t.y), {
      dMin: d,
      sigmaD: 0.3,
      sigmaP: 3,
      flags: FLAGS.LIVECHART_ADJUSTED,
      cellRef: 0
    });
  }
  return store;
}

/** A look-ahead hull: the convex hull of a hull rectangle and its copy moved along the track. */
const footprintArb = fc.record({
  x: fraction,
  y: fraction,
  heading: uniform(0, 2 * Math.PI),
  length: uniform(0, 60),
  beam: uniform(1, 12),
  run: uniform(0, 200)
});

type Footprint = typeof footprintArb extends fc.Arbitrary<infer T> ? T : never;

function ring(f: Footprint): LonLat[] {
  const c: LonLat = [W + f.x * SPAN_LON, S + f.y * SPAN_LAT];
  if (f.length < 2) {
    return [c];
  }
  const end = project(c, f.heading, f.run);
  const corners = (p: LonLat): LonLat[] => {
    const bow = project(p, f.heading, f.length / 2);
    const stern = project(p, f.heading + Math.PI, f.length / 2);
    const side = (q: LonLat, s: number) => project(q, f.heading + s * (Math.PI / 2), f.beam / 2);
    return [side(bow, 1), side(stern, 1), side(stern, -1), side(bow, -1)];
  };
  // Stern of the first hull, bow of the moved one: a convex hexagon around both.
  const [a1, a2, a3, a4] = corners(c) as [LonLat, LonLat, LonLat, LonLat];
  const [b1, , , b4] = corners(end) as [LonLat, LonLat, LonLat, LonLat];
  return f.run < 1 ? [a1, a2, a3, a4] : [b1, a1, a2, a3, a4, b4];
}

const optionsArb = fc.record({
  bufferMetres: uniform(0, 120),
  clearAbove: fc.option(uniform(-5, 30), { nil: undefined }),
  risk: fc.option(fc.record({ threshold: uniform(-1, 12), sigmaExtra: uniform(0.05, 1.5) }), {
    nil: undefined,
    freq: 4
  }),
  chartOnly: fc.boolean(),
  stopWhenCertain: fc.boolean()
});

describe("graded walk equality (property)", () => {
  test("with chart position every query returns what the 118913f walk returns", () => {
    fc.assert(
      fc.property(
        chartArb,
        fc.array(fc.tuple(footprintArb, optionsArb), { minLength: 1, maxLength: 8 }),
        (c, queries) => {
          const store = storeOf(c);
          for (const [f, o] of queries) {
            const geom = footprintGeom(ring(f));
            const opts = { ...o, chartPosition: true };
            expect(minDepthOver(store, geom, opts)).toEqual(referenceGradedWalk(store, geom, opts));
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  test("a walk that knows its index's cells leaves subtrees out and returns the same", () => {
    const bad: unknown[] = [];
    let fewer = 0;
    let walks = 0;
    fc.assert(
      fc.property(
        chartArb,
        fc.array(fc.tuple(footprintArb, optionsArb, fc.boolean()), { minLength: 1, maxLength: 8 }),
        (c, queries) => {
          const store = storeOf(c);
          for (const [f, o, sweptOnly] of queries) {
            const geom = footprintGeom(ring(f));
            const opts = { ...o, chartPosition: true, sweptOnly };
            store.cellCount = undefined;
            const want = minDepthOver(store, geom, opts);
            // Every feature of the synthetic chart is cell 0's.
            store.cellCount = 1;
            const got = minDepthOver(store, geom, opts);
            walks++;
            fewer += got.visits < want.visits ? 1 : 0;
            if (!sameWithFewerVisits(got, want)) {
              bad.push({ c, f, opts, got, want });
            }
          }
        }
      ),
      { numRuns: 150 }
    );
    expect(bad.slice(0, 2)).toEqual([]);
    // The rule is exercised: a good share of the walks are shorter for it.
    expect(fewer).toBeGreaterThan(walks / 20);
  });

  test("a walk that knows its index's cells descends a subtree reaching a block not loaded", () => {
    // A zoom 12 tile whose two northern quarters hold the same shoal and rock; blocks at zoom
    // 13 under the resident zooms 12-14, only the north-west one loaded. The walk takes the
    // north-west quarter first, after which the north-east one adds nothing it holds.
    const t = tileAt(12, ...toMercator(W + 0.01, S + 0.01));
    const r = tileRect(12, t.x, t.y);
    const [w, s] = fromMercator(r.minX, r.minY);
    const [e, n] = fromMercator(r.maxX, r.maxY);
    const half = (e - w) / 2;
    const mid = (s + n) / 2;
    const at = (f: number): number => mid + (n - mid) * f;
    const all: Box = [w - 0.05, s - 0.05, e + 0.05, n + 0.05];
    const store = buildPyramid(
      [
        ...basin(all, 20),
        quality(all, 2),
        ...[w, w + half].flatMap((x0) => [
          area([x0 + half * 0.3, at(0.3), x0 + half * 0.4, at(0.4)], 8),
          point(x0 + half * 0.6, at(0.6), 5)
        ])
      ],
      { minZoom: 12, leafZoom: 18 }
    );
    const file = serializePyramid(store, { residentZoom: 14, blockZoom: 13 });
    const cold = pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: -1 });
    cacheOf(cold)?.loadNow(tileKey(13, 2 * t.x, 2 * t.y));
    const geom = footprintGeom([
      [w + 1e-7, at(0.05)],
      [e - 1e-7, at(0.05)],
      [e - 1e-7, n - 1e-7],
      [w + 1e-7, n - 1e-7]
    ]);
    for (const opts of [{}, { chartPosition: true }]) {
      cold.cellCount = undefined;
      const want = minDepthOver(cold, geom, opts);
      cold.cellCount = 1;
      const got = minDepthOver(cold, geom, opts);
      expect(want.flags & FLAGS.NO_COVERAGE).toBe(FLAGS.NO_COVERAGE);
      expect(sameWithFewerVisits(got, want)).toBe(true);
      expect(got.visits).toBeLessThan(want.visits);
    }
  });

  /**
   * CATZOC B water to `edge` metres north of the footprint and D beyond, a
   * bank `bank` metres north: the bank counts by its own σ or, behind enough
   * B water, by the survey shadow (`survey-shadow.test.ts`).
   */
  test("behind CATZOC B water the shadowed weights equal the 118913f walk's", () => {
    const at: LonLat = [W + SPAN_LON / 2, S + SPAN_LAT / 3];
    const north = (m: number): number => at[1] + m / 111195;
    let shadowed = 0;
    fc.assert(
      fc.property(
        uniform(0, 400),
        uniform(50, 900),
        uniform(-2, 3),
        fc.array(fc.tuple(footprintArb, optionsArb), { minLength: 1, maxLength: 6 }),
        (edge, bank, depth, queries) => {
          const store = buildPyramid(
            [
              coverage(DOMAIN),
              quality([DOMAIN[0], DOMAIN[1], DOMAIN[2], north(edge)], 3),
              quality([DOMAIN[0], north(edge), DOMAIN[2], DOMAIN[3]], 5),
              area(DOMAIN, 15),
              area([DOMAIN[0], north(bank), DOMAIN[2], north(bank + 100)], depth)
            ],
            { minZoom: 12, leafZoom: 18 }
          );
          for (const [f, o] of queries) {
            // Footprints within 100 m of `at`.
            const near = { ...f, x: 0.5 + (f.x - 0.5) * 0.2, y: 1 / 3 + (f.y - 0.5) * 0.4 };
            const geom = footprintGeom(ring(near));
            const opts = {
              ...o,
              chartPosition: true,
              risk: o.risk ?? { threshold: 2, sigmaExtra: 0.3 }
            };
            const got = minDepthOver(store, geom, opts);
            shadowed += got.riskTile?.chart?.shadow ? 1 : 0;
            expect(got).toEqual(referenceGradedWalk(store, geom, opts));
          }
        }
      ),
      { numRuns: 30 }
    );
    expect(shadowed).toBeGreaterThan(0);
  });
});

describe("look-ahead over the fixture chart", () => {
  const NOW = 1_800_000_000_000;
  const index = fixtureIndex();
  const file = serializePyramid(index.pyramid, { residentZoom: 15, blockZoom: 13 });

  /**
   * The index with only the blocks whose bit is set in `mask` loaded: the rest read as stand-ins.
   * It knows its cells, as `loadChartIndex` makes it, so a walk may leave a subtree out, but not
   * one that reaches a block not loaded.
   */
  function partly(mask: number): ChartIndex {
    const p = pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: -1 });
    const cache = cacheOf(p);
    cache?.keys().forEach((key, i) => {
      if (mask & (1 << i)) {
        cache.loadNow(key);
      }
    });
    return countedCells({ ...index, pyramid: p });
  }

  test("every chart walk of a tick returns what the 118913f walk returns", () => {
    const real = pyramid.minDepthOver;
    const bad: unknown[] = [];
    let calls = 0;
    const spy = jest.spyOn(pyramid, "minDepthOver").mockImplementation((store, geom, opts) => {
      const got = real(store, geom, opts);
      const want = referenceGradedWalk(store, geom, opts);
      calls++;
      // Object.is on every value, as toEqual, but one assertion for the whole run. The
      // fixture's index knows its cells, so a walk may visit fewer tiles for the same answer.
      if (!sameWithFewerVisits(got, want)) {
        bad.push({ geom, opts, got, want });
      }
      return got;
    });
    try {
      fc.assert(
        fc.property(
          fc.tuple(uniform(21.998, 22.042), uniform(59.984, 60.022)),
          uniform(0, 2 * Math.PI),
          uniform(0.5, 6),
          uniform(1, 4),
          fc.integer({ min: 0, max: 16 }),
          ([lon, lat], cog, sog, draft, mask) => {
            const nav: NavState = {
              position: { value: [lon, lat], at: NOW },
              cog: { value: cog, at: NOW },
              sog: { value: sog, at: NOW },
              heading: { value: cog, at: NOW }
            };
            const chart = mask === 16 ? index : partly(mask);
            evaluateLookahead(nav, ctx({ draft, length: 12, beam: 4 }), chart, NOW);
          }
        ),
        { numRuns: 40 }
      );
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThan(100);
    expect(bad.slice(0, 3)).toEqual([]);
  });
});
