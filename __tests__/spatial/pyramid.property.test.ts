import fc from "fast-check";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { fraction, uniform } from "../helpers/arbitraries";
import type { Box } from "../helpers/synthetic";
import { area, basin, boxRing, coverage, point, quality } from "../helpers/synthetic";

/**
 * Safety invariant 1 (AGENTS.md, plan §4.3): for any footprint and buffer,
 * minDepthOver never reports a depth deeper than a source feature within
 * the buffer of the footprint.
 *
 * The oracle measures distances in a local flat frame, independently of the
 * Mercator code under test, and shrinks the buffer slightly so projection
 * differences at the boundary cannot cause a false failure.
 */

const W = 22.0;
const S = 60.0;
const SPAN_LON = 0.02;
const SPAN_LAT = 0.01;
const DOMAIN: Box = [W, S, W + SPAN_LON, S + SPAN_LAT];
const BASE_DEPTH = 30;
const M_PER_DEG_LAT = (Math.PI / 180) * 6378137;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(((S + SPAN_LAT / 2) * Math.PI) / 180);

const local = (lon: number, lat: number): [number, number] => [
  (lon - W) * M_PER_DEG_LON,
  (lat - S) * M_PER_DEG_LAT
];

function boxDistance(a: Box, b: Box): number {
  const [ax0, ay0] = local(a[0], a[1]);
  const [ax1, ay1] = local(a[2], a[3]);
  const [bx0, by0] = local(b[0], b[1]);
  const [bx1, by1] = local(b[2], b[3]);
  const dx = Math.max(bx0 - ax1, 0, ax0 - bx1);
  const dy = Math.max(by0 - ay1, 0, ay0 - by1);
  return Math.hypot(dx, dy);
}

type Interval = readonly [number, number];
type Unit = { kind: "box" | "point"; x: Interval; y: Interval };

const unitInterval = fc
  .tuple(fraction, fraction)
  .map(([a, b]): Interval => [Math.min(a, b), Math.max(a, b)]);

const unitBox = fc.record({
  kind: fc.constant("box" as const),
  x: unitInterval,
  y: unitInterval
});

const unitPoint = fc
  .tuple(fraction, fraction)
  .map(([a, b]): Unit => ({ kind: "point", x: [a, a], y: [b, b] }));

const within = ([lo, hi]: Interval, [a, b]: Interval): Interval => [
  lo + a * (hi - lo),
  lo + b * (hi - lo)
];

/** Places a unit-square box or point inside the given fractions of DOMAIN. */
function place(u: Unit, x: Interval = [0, 1], y: Interval = [0, 1]): Box {
  const [x0, x1] = within(x, u.x);
  const [y0, y1] = within(y, u.y);
  const lon0 = W + x0 * SPAN_LON;
  const lat0 = S + y0 * SPAN_LAT;
  if (u.kind === "point") {
    return [lon0, lat0, lon0, lat0];
  }
  return [
    lon0,
    lat0,
    Math.max(W + x1 * SPAN_LON, lon0 + 1e-5),
    Math.max(S + y1 * SPAN_LAT, lat0 + 1e-5)
  ];
}

const boxArb = unitBox.map((u) => place(u));
const pointArb = unitPoint.map((u) => place(u));
const queryUnit = fc.oneof(unitBox, unitPoint);

const scenario = fc.record({
  areas: fc.array(fc.tuple(boxArb, uniform(-2, 25)), { maxLength: 4 }),
  points: fc.array(fc.tuple(pointArb, uniform(0, 20)), { maxLength: 6 }),
  query: queryUnit.map((u) => place(u)),
  buffer: uniform(0, 60)
});

describe("pyramid conservativeness (property)", () => {
  test("minDepthOver ≤ every source depth within the buffer", () => {
    fc.assert(
      fc.property(scenario, ({ areas, points, query, buffer }) => {
        const features = [
          ...basin(DOMAIN, BASE_DEPTH),
          ...areas.map(([b, d]) => area(b, d)),
          ...points.map(([b, d]) => point(b[0], b[1], d))
        ];
        const store = buildPyramid(features, { minZoom: 13, leafZoom: 17 });
        const isPoint = query[0] === query[2] && query[1] === query[3];
        const geom = footprintGeom(isPoint ? [[query[0], query[1]]] : boxRing(query));
        const result = minDepthOver(store, geom, { bufferMetres: buffer });

        const reach = buffer * 0.98;
        let oracle = BASE_DEPTH;
        for (const [b, d] of [...areas, ...points]) {
          if (boxDistance(b, query) <= reach) {
            oracle = Math.min(oracle, d);
          }
        }
        expect(result.dMin).toBeLessThanOrEqual(oracle);
      }),
      { numRuns: 150 }
    );
  });
});

/**
 * With two overlapping usage bands, the larger-scale cell decides wherever
 * it has coverage and the smaller scale fills the rest (plan §4.2). Each case
 * puts the buffered footprint, plus one leaf tile (~150 m), wholly on one
 * side of the fine cell's coverage edge and checks it against that side's
 * features; straddling footprints are left out, as either answer can be
 * right there.
 */
function expandBox(b: Box, metres: number): Box {
  const dLon = metres / M_PER_DEG_LON;
  const dLat = metres / M_PER_DEG_LAT;
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

function insideBox(inner: Box, outer: Box): boolean {
  return (
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
  );
}

function disjoint(a: Box, b: Box): boolean {
  return a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
}

const MAX_BUFFER = 40;
const EDGE_MARGIN = MAX_BUFFER + 160;
/** 0.2 of either DOMAIN span is over 220 m, more than EDGE_MARGIN. */
const GAP = 0.2;

const longInterval = fc
  .tuple(fraction, uniform(2 * GAP + 0.05, 1))
  .map(([at, length]): Interval => [at * (1 - length), at * (1 - length) + length]);

const fineSide = fc
  .record({ x: longInterval, y: longInterval, query: queryUnit })
  .map(({ x, y, query }) => ({
    side: "fine" as const,
    fine: place({ kind: "box", x, y }),
    query: place(query, [x[0] + GAP, x[1] - GAP], [y[0] + GAP, y[1] - GAP])
  }));

const coarseSide = fc
  .record({
    alongLon: fc.boolean(),
    mirror: fc.boolean(),
    split: uniform(0.25, 0.75),
    fine: unitBox,
    query: queryUnit
  })
  .map(({ alongLon, mirror, split, fine, query }) => {
    const flip = ([a, b]: Interval): Interval => (mirror ? [1 - b, 1 - a] : [a, b]);
    const fineAxis = flip([0, split - GAP / 2]);
    const queryAxis = flip([split + GAP / 2, 1]);
    return {
      side: "coarse" as const,
      fine: alongLon ? place(fine, fineAxis) : place(fine, undefined, fineAxis),
      query: alongLon ? place(query, queryAxis) : place(query, undefined, queryAxis)
    };
  });

const mosaic = fc.record({
  layout: fc.oneof(fineSide, coarseSide),
  fineBase: uniform(0, 40),
  fineAreas: fc.array(fc.tuple(boxArb, uniform(0, 25)), { maxLength: 3 }),
  coarseAreas: fc.array(fc.tuple(boxArb, uniform(0, 25)), { maxLength: 3 }),
  buffer: uniform(0, MAX_BUFFER)
});

describe("usage-band mosaic (property)", () => {
  test("the covering band's features bound the answer", () => {
    fc.assert(
      fc.property(mosaic, ({ layout, fineBase, fineAreas, coarseAreas, buffer }) => {
        const { side, fine, query } = layout;
        const features = [
          ...basin(DOMAIN, BASE_DEPTH, { band: 3, cellRef: 1 }),
          ...coarseAreas.map(([b, d]) => area(b, d, { band: 3, cellRef: 1 })),
          coverage(fine, { band: 5, cellRef: 0 }),
          quality(fine, 1, { band: 5, cellRef: 0 }),
          area(fine, fineBase, { band: 5, cellRef: 0 }),
          ...fineAreas.map(([b, d]) => area(b, d, { band: 5, cellRef: 0 }))
        ];
        const store = buildPyramid(features, { minZoom: 13, leafZoom: 17 });
        const isPoint = query[0] === query[2] && query[1] === query[3];
        const geom = footprintGeom(isPoint ? [[query[0], query[1]]] : boxRing(query));
        const result = minDepthOver(store, geom, { bufferMetres: buffer });

        const reach = expandBox(query, EDGE_MARGIN);
        expect(side === "fine" ? insideBox(reach, fine) : disjoint(reach, fine)).toBe(true);
        let oracle = side === "fine" ? fineBase : BASE_DEPTH;
        for (const [b, d] of side === "fine" ? fineAreas : coarseAreas) {
          if (boxDistance(b, query) <= buffer * 0.98) {
            oracle = Math.min(oracle, d);
          }
        }
        expect(result.dMin).toBeLessThanOrEqual(oracle);
      }),
      { numRuns: 150 }
    );
  });
});
