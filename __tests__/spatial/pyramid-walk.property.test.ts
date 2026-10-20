import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import { project, tileAt, tileKey, toMercator } from "../../src/foundation/geo";
import type { Catzoc } from "../../src/ingest/features";
import { FLAGS } from "../../src/spatial/node-store";
import type { QueryOptions } from "../../src/spatial/pyramid";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { fraction, uniform } from "../helpers/arbitraries";
import { referenceMinDepthOver } from "../helpers/reference-pyramid";
import type { Box } from "../helpers/synthetic";
import { area, basin, boxRing, coverage, land, point, quality } from "../helpers/synthetic";

/**
 * The tile walk's speed-ups (sqrt distances, a reused tile rectangle,
 * in-place folding, skipping the tests under a tile wholly in reach) must
 * not change any query's answer:
 * the current walk and the ea8277a walk agree on every field, visits
 * included, over random charts, footprints and options.
 */

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

const chart = fc.record({
  areas: fc.array(fc.tuple(boxIn, uniform(-2, 25)), { maxLength: 4 }),
  lands: fc.array(boxIn, { maxLength: 2 }),
  rocks: fc.array(fc.tuple(fraction, fraction, uniform(0, 10)), { maxLength: 6 }),
  zones: fc.array(fc.tuple(boxIn, fc.integer({ min: 1, max: 6 })), { maxLength: 2 }),
  /** Leaves part of the domain uncovered. */
  gap: fc.boolean(),
  adjust: fc.array(fc.tuple(fraction, fraction, uniform(0, 8)), { maxLength: 3 })
});

/** A rotated hull rectangle or a point, inside the domain. */
const footprintArb = fc.record({
  x: fraction,
  y: fraction,
  heading: uniform(0, 2 * Math.PI),
  length: uniform(0, 400),
  beam: uniform(1, 60)
});

const optionsArb = fc.record({
  bufferMetres: uniform(0, 300),
  chartReachK: fc.constantFrom(0, 2),
  clearAbove: fc.option(uniform(-5, 30), { nil: undefined }),
  risk: fc.option(fc.record({ threshold: uniform(-1, 12), sigmaExtra: uniform(0.05, 1.5) }), {
    nil: undefined
  }),
  chartOnly: fc.boolean()
});

/** A ring of up to 60 vertices around a centre, convex or jagged, as a /query polygon. */
const blobArb = fc.record({
  x: fraction,
  y: fraction,
  radii: fc.array(uniform(20, 700), { minLength: 3, maxLength: 60 })
});

function blob(b: { x: number; y: number; radii: number[] }): LonLat[] {
  const c: LonLat = [W + b.x * SPAN_LON, S + b.y * SPAN_LAT];
  return b.radii.map((r, i) => project(c, (2 * Math.PI * i) / b.radii.length, r));
}

function ring(f: { x: number; y: number; heading: number; length: number; beam: number }) {
  const c: LonLat = [W + f.x * SPAN_LON, S + f.y * SPAN_LAT];
  if (f.length < 5) {
    return [c];
  }
  const bow = project(c, f.heading, f.length / 2);
  const stern = project(c, f.heading + Math.PI, f.length / 2);
  const side = (p: LonLat, s: number) => project(p, f.heading + s * (Math.PI / 2), f.beam / 2);
  return [side(bow, 1), side(stern, 1), side(stern, -1), side(bow, -1)];
}

type Chart = typeof chart extends fc.Arbitrary<infer T> ? T : never;

function storeOf(c: Chart) {
  const covered: Box = c.gap ? [W, S, W + SPAN_LON * 0.7, S + SPAN_LAT] : DOMAIN;
  const features = [
    ...basin(covered, 20),
    ...c.areas.map(([b, d]) => area(b, d)),
    ...c.lands.map((b) => land(b)),
    ...c.rocks.map(([x, y, d]) => point(W + x * SPAN_LON, S + y * SPAN_LAT, d)),
    ...c.zones.map(([b, z]) => quality(b, z as Catzoc)),
    coverage(covered)
  ];
  const store = buildPyramid(features, { minZoom: 12, leafZoom: 18 });
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

describe("tile walk equality (property)", () => {
  test("the walk returns what the ea8277a walk returns", () => {
    fc.assert(
      fc.property(
        chart,
        fc.array(fc.tuple(footprintArb, optionsArb), { minLength: 1, maxLength: 8 }),
        (c, queries) => {
          const store = storeOf(c);
          for (const [f, opts] of queries) {
            const geom = footprintGeom(ring(f));
            expect(minDepthOver(store, geom, opts)).toEqual(
              referenceMinDepthOver(store, geom, opts)
            );
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  test("polygons of many vertices return what the ea8277a walk returns", () => {
    fc.assert(
      fc.property(
        chart,
        fc.array(fc.tuple(blobArb, optionsArb), { minLength: 1, maxLength: 4 }),
        (c, queries) => {
          const store = storeOf(c);
          for (const [b, opts] of queries) {
            const geom = footprintGeom(blob(b));
            expect(minDepthOver(store, geom, opts)).toEqual(
              referenceMinDepthOver(store, geom, opts)
            );
          }
        }
      ),
      { numRuns: 40 }
    );
  });

  test("stopping at certain land keeps every value but flags, σ and cells", () => {
    const risk = fc.record({ threshold: uniform(-1, 12), sigmaExtra: uniform(0.05, 1.5) });
    let stopped = 0;
    fc.assert(
      fc.property(
        chart.map((c) => ({ ...c, lands: [...c.lands, c.areas[0]?.[0] ?? DOMAIN] })),
        fc.array(fc.tuple(footprintArb, optionsArb, risk), { minLength: 1, maxLength: 8 }),
        (c, queries) => {
          const store = storeOf(c);
          for (const [f, opts, r] of queries) {
            const geom = footprintGeom(ring(f));
            const full = referenceMinDepthOver(store, geom, { ...opts, risk: r });
            const fast = minDepthOver(store, geom, { ...opts, risk: r, stopWhenCertain: true });
            const fields = (x: typeof full) => ({
              dMin: x.dMin,
              cellRef: x.cellRef,
              coveredDMin: x.coveredDMin,
              maxRisk: x.maxRisk,
              riskTile: x.riskTile,
              worst: x.worst
            });
            expect(fields(fast)).toEqual(fields(full));
            expect(fast.flags & ~full.flags).toBe(0);
            expect(fast.visits).toBeLessThanOrEqual(full.visits);
            if (fast.visits < full.visits) {
              stopped++;
            } else {
              expect(fast).toEqual(full);
            }
          }
        }
      ),
      { numRuns: 60 }
    );
    expect(stopped).toBeGreaterThan(0);
  });
});
