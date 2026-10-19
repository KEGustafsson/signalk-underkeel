import fc from "fast-check";
import type { Catzoc, ChartFeature } from "../../src/ingest/features";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { deserializePyramid, serializePyramid } from "../../src/spatial/store";
import { fromMercator, tileAt, tileRect, toMercator } from "../../src/foundation/geo";
import type { Box } from "../helpers/synthetic";
import { area, boxRing, coverage, point, quality } from "../helpers/synthetic";

/**
 * Chart position reach (plan §4.3): with `chartReachK` a tile counts within
 * the buffer plus k·σP of its own survey, so a depth area drawn beside the
 * footprint is found as far off as its survey may have misplaced it, and a
 * poor survey elsewhere widens nothing here.
 */

const M_PER_DEG_LAT = 111195;
const BOX: Box = [22.0, 60.0, 22.08, 60.04];
const AT: [number, number] = [22.03, 60.015];
const north = (m: number): number => AT[1] + m / M_PER_DEG_LAT;
/** A drying patch whose south edge is `m` metres north of AT. */
const dryingNorth = (m: number) =>
  area([AT[0] - 0.002, north(m), AT[0] + 0.002, north(m + 50)], -1);

function query(features: ChartFeature[], k = 2, bufferMetres = 10) {
  const store = buildPyramid(features, { minZoom: 12, leafZoom: 20 });
  return minDepthOver(store, footprintGeom([AT]), { bufferMetres, chartReachK: k });
}

describe("chart position reach", () => {
  test("an A1 rock 60 m off is not widened by a CATZOC C zone 2 km away", () => {
    const cZone: Box = [22.0, 60.0, 22.08, north(-2000)];
    const features = [
      coverage(BOX),
      quality([22.0, north(-2000), 22.08, 60.04], 1),
      quality(cZone, 4),
      area(BOX, 20),
      area([22.0, 60.0, 22.08, north(-2300)], 0.5),
      point(AT[0], north(60), 1)
    ];
    const r = query(features);
    expect(r.dMin).toBe(20);
    expect(r.flags & FLAGS.UNASSESSED).toBe(0);
    // The same rock under the C survey is in reach.
    const inC = query([coverage(BOX), quality(BOX, 4), area(BOX, 20), point(AT[0], north(60), 1)]);
    expect(inC.dMin).toBe(1);
  });

  test("C water within reach widens only its own tiles, not an A1 rock beside it", () => {
    const features = [
      coverage(BOX),
      quality([22.0, north(-90), 22.08, 60.04], 1),
      quality([22.0, 60.0, 22.08, north(-90)], 4),
      area(BOX, 20),
      area([22.0, north(-400), 22.08, north(-300)], 12),
      point(AT[0], north(150), 1)
    ];
    // The 12 m patch, 300 m off in C water, counts; the rock 150 m off in A1 does not.
    expect(query(features, 2, 100).dMin).toBe(12);
  });

  test.each<[Catzoc, string]>([
    [3, "B"],
    [4, "C"]
  ])("a drying area 60 m off under CATZOC %s (%s) is found", (catzoc) => {
    const features = [coverage(BOX), quality(BOX, catzoc), area(BOX, 15), dryingNorth(60)];
    expect(query(features).dMin).toBe(-1);
    // Without the chart's position the 10 m buffer stops short of it.
    expect(query(features, 0).dMin).toBe(15);
  });

  test("an A1 survey keeps the same area out of reach", () => {
    expect(query([coverage(BOX), quality(BOX, 1), area(BOX, 15), dryingNorth(60)]).dMin).toBe(15);
  });

  test.each([
    ["no survey quality", [] as ChartFeature[]],
    ["CATZOC U", [quality(BOX, 6)]],
    ["Traficom WFS water", [{ ...quality(BOX, 4), advisory: true }]]
  ])("%s adds no reach", (_, zones) => {
    const advisory = zones.some((z) => z.advisory);
    const features = [
      { ...coverage(BOX), advisory },
      ...zones,
      { ...area(BOX, 15), advisory },
      { ...dryingNorth(60), advisory }
    ];
    const r = query(features);
    expect(r.dMin).toBe(15);
    expect(r.flags & (FLAGS.UNASSESSED | FLAGS.NOT_FOR_NAVIGATION)).not.toBe(0);
  });
});

/**
 * Safety invariant 1 with chart reach: the answer is never deeper than an
 * area within the buffer plus k·σP of the least uncertain survey it lies
 * in. Distances are measured in a flat local frame, and the reach shrunk
 * slightly so projection differences at the boundary cannot decide.
 */
const W = 22.0;
const S = 60.0;
const SPAN_LON = 0.04;
const SPAN_LAT = 0.02;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(((S + SPAN_LAT / 2) * Math.PI) / 180);
const SIGMA_P: Record<number, number> = { 1: 2.5, 2: 10, 3: 25, 4: 250, 6: 0 };

function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(b[0] - a[2], 0, a[0] - b[2]) * M_PER_DEG_LON;
  const dy = Math.max(b[1] - a[3], 0, a[1] - b[3]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

const frac = fc.double({ min: 0, max: 1, noNaN: true });
const boxArb = fc.tuple(frac, frac, frac, frac).map(([a, b, c, d]): Box => {
  const lon0 = W + Math.min(a, b) * SPAN_LON;
  const lat0 = S + Math.min(c, d) * SPAN_LAT;
  return [
    lon0,
    lat0,
    Math.max(W + Math.max(a, b) * SPAN_LON, lon0 + 1e-5),
    Math.max(S + Math.max(c, d) * SPAN_LAT, lat0 + 1e-5)
  ];
});

describe("leaves only partly in an assessed survey", () => {
  test("a drying area in a leaf on the coverage edge is reached from B water 7 m off", () => {
    // fast-check counterexample: the area's leaf is partly outside coverage and quality.
    const domain: Box = [W, S, W + SPAN_LON, S + SPAN_LAT];
    const features = [
      coverage(domain),
      quality([W, S, W + SPAN_LON, S + SPAN_LAT / 3], 3),
      quality([W, S + SPAN_LAT / 3, W + SPAN_LON, S + (2 * SPAN_LAT) / 3], 1),
      quality([W, S + (2 * SPAN_LAT) / 3, W + SPAN_LON, S + SPAN_LAT], 1),
      area(domain, 30),
      area([22, 60, 22.00001, 60.00001], 0)
    ];
    const store = buildPyramid(features, { minZoom: 13, leafZoom: 17 });
    const q: Box = [22.00012207031249, 60, 22.00013207031249, 60.00001];
    const r = minDepthOver(store, footprintGeom(boxRing(q)), { chartReachK: 2 });
    expect(r.dMin).toBeLessThanOrEqual(0);
  });

  test("a drying area in a leaf straddling B and U water is reached from B water 40 m off", () => {
    // A z20 leaf the B/U boundary cuts in half; the patch lies in its B half.
    const at: [number, number] = [22.03, 60.015];
    const [mx, my] = toMercator(at[0], at[1]);
    const leaf = tileAt(20, mx, my);
    const r20 = tileRect(20, leaf.x, leaf.y);
    const [west, south] = fromMercator(r20.minX, r20.minY);
    const [east, north] = fromMercator(r20.maxX, r20.maxY);
    const seam = (west + east) / 2;
    const midLat = (south + north) / 2;
    const patch: Box = [
      west + (seam - west) / 4,
      midLat - 0.00002,
      seam - (seam - west) / 4,
      midLat
    ];
    const features = [
      coverage(BOX),
      quality([BOX[0], BOX[1], seam, BOX[3]], 3),
      quality([seam, BOX[1], BOX[2], BOX[3]], 6),
      area(BOX, 15),
      area(patch, -1)
    ];
    const store = buildPyramid(features, { minZoom: 12, leafZoom: 20 });
    const from: [number, number] = [patch[0] - 40 / M_PER_DEG_LON, midLat];
    const r = minDepthOver(store, footprintGeom([from]), { chartReachK: 2 });
    expect(r.dMin).toBe(-1);
    // Without the chart's position the patch is out of reach.
    expect(minDepthOver(store, footprintGeom([from])).dMin).toBe(15);
    // The survey σP column survives a save and reload.
    const reloaded = deserializePyramid(serializePyramid(store));
    expect(minDepthOver(reloaded, footprintGeom([from]), { chartReachK: 2 })).toEqual(r);
  });
});

describe("chart position reach conservativeness (property)", () => {
  test("minDepthOver ≤ every area within the buffer plus k·σP of its survey", () => {
    const catzoc = fc.constantFrom<Catzoc>(1, 2, 3, 4, 6);
    fc.assert(
      fc.property(
        fc.record({
          zones: fc.tuple(catzoc, catzoc, catzoc),
          areas: fc.array(fc.tuple(boxArb, fc.double({ min: -2, max: 25, noNaN: true })), {
            maxLength: 4
          }),
          query: boxArb,
          buffer: fc.double({ min: 0, max: 40, noNaN: true })
        }),
        ({ zones, areas, query: q, buffer }) => {
          // Three strips sharing their edges, south to north.
          const strips = zones.map((c, i): [Box, number] => [
            [W, S + (i * SPAN_LAT) / 3, W + SPAN_LON, S + ((i + 1) * SPAN_LAT) / 3],
            c
          ]);
          const domain: Box = [W, S, W + SPAN_LON, S + SPAN_LAT];
          const features = [
            coverage(domain),
            ...strips.map(([b, c]) => quality(b, c as Catzoc)),
            area(domain, 30),
            ...areas.map(([b, d]) => area(b, d))
          ];
          const store = buildPyramid(features, { minZoom: 13, leafZoom: 17 });
          const r = minDepthOver(store, footprintGeom(boxRing(q)), {
            bufferMetres: buffer,
            chartReachK: 2
          });
          let oracle = 30;
          for (const [b, d] of areas) {
            const sigma = Math.min(
              ...strips.filter(([s]) => boxDistance(s, b) === 0).map(([, c]) => SIGMA_P[c] ?? 0)
            );
            if (boxDistance(b, q) <= (buffer + 2 * sigma) * 0.98) {
              oracle = Math.min(oracle, d);
            }
          }
          expect(r.dMin).toBeLessThanOrEqual(oracle);
        }
      ),
      { numRuns: 200 }
    );
  });
});
