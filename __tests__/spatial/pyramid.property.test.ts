import fc from "fast-check";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
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

const frac = fc.double({ min: 0, max: 1, noNaN: true });

const boxArb = fc.tuple(frac, frac, frac, frac).map(([a, b, c, d]): Box => {
  const lon0 = W + Math.min(a, b) * SPAN_LON;
  const lon1 = W + Math.max(a, b) * SPAN_LON;
  const lat0 = S + Math.min(c, d) * SPAN_LAT;
  const lat1 = S + Math.max(c, d) * SPAN_LAT;
  return [lon0, lat0, Math.max(lon1, lon0 + 1e-5), Math.max(lat1, lat0 + 1e-5)];
});

const pointArb = fc.tuple(frac, frac).map(([a, b]): Box => {
  const lon = W + a * SPAN_LON;
  const lat = S + b * SPAN_LAT;
  return [lon, lat, lon, lat];
});

const scenario = fc.record({
  areas: fc.array(fc.tuple(boxArb, fc.double({ min: -2, max: 25, noNaN: true })), {
    maxLength: 4
  }),
  points: fc.array(fc.tuple(pointArb, fc.double({ min: 0, max: 20, noNaN: true })), {
    maxLength: 6
  }),
  query: fc.oneof(boxArb, pointArb),
  buffer: fc.double({ min: 0, max: 60, noNaN: true })
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
 * it has coverage and the smaller scale fills the rest (plan §4.2). Queries
 * whose buffered footprint lies wholly on one side are checked against that
 * side's features; footprints straddling the coverage edge are skipped, as
 * either answer can be right there.
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

const mosaic = fc.record({
  fine: boxArb,
  fineBase: fc.double({ min: 0, max: 40, noNaN: true }),
  fineAreas: fc.array(fc.tuple(boxArb, fc.double({ min: 0, max: 25, noNaN: true })), {
    maxLength: 3
  }),
  coarseAreas: fc.array(fc.tuple(boxArb, fc.double({ min: 0, max: 25, noNaN: true })), {
    maxLength: 3
  }),
  query: fc.oneof(boxArb, pointArb),
  buffer: fc.double({ min: 0, max: 40, noNaN: true })
});

describe("usage-band mosaic (property)", () => {
  test("the covering band's features bound the answer", () => {
    fc.assert(
      fc.property(mosaic, ({ fine, fineBase, fineAreas, coarseAreas, query, buffer }) => {
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
        // Margin: one leaf tile (~150 m) plus the buffer, so tile-edge effects never decide.
        const reach = expandBox(query, buffer + 160);
        let side: [Box, number][] | undefined;
        let base = 0;
        if (insideBox(reach, fine)) {
          side = fineAreas;
          base = fineBase;
        } else if (disjoint(reach, fine)) {
          side = coarseAreas;
          base = BASE_DEPTH;
        }
        if (side === undefined) {
          return;
        }
        let oracle = base;
        for (const [b, d] of side) {
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
