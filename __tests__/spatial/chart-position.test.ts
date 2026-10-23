import fc from "fast-check";
import { fromMercator, tileAt, tileRect, toMercator } from "../../src/foundation/geo";
import { normalCdf } from "../../src/foundation/stats";
import type { Catzoc, ChartFeature, DepthFeature } from "../../src/ingest/features";
import { chartWeight, MAX_CHART_SIGMA } from "../../src/spatial/chart-position";
import { FLAGS } from "../../src/spatial/node-store";
import type { QueryOptions } from "../../src/spatial/pyramid";
import { footprintGeom, minDepthOver, RISK_STOP_BELOW } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { sigmaFor } from "../../src/spatial/quality";
import { deserializePyramid, serializePyramid } from "../../src/spatial/store";
import type { Box } from "../helpers/synthetic";
import { area, boxRing, coverage, land, point, quality } from "../helpers/synthetic";

/**
 * Graded chart position (plan §4.3): a tile beyond the footprint and its
 * buffer counts with its P(UKC < 0) times Φ(−g/σP), the chance the chart is
 * off by its distance g; the depth reported under the footprint is the depth
 * charted there; land and shoreline objects with a σ of their own spread by
 * it rather than by the survey's.
 */

const M_PER_DEG_LAT = 111195;
const BOX: Box = [22.0, 60.0, 22.08, 60.04];
const AT: [number, number] = [22.03, 60.015];
const M_PER_DEG_LON_AT = M_PER_DEG_LAT * Math.cos((AT[1] * Math.PI) / 180);
const north = (m: number): number => AT[1] + m / M_PER_DEG_LAT;
/** A drying patch whose south edge is `m` metres north of AT. */
const dryingNorth = (m: number) =>
  area([AT[0] - 0.002, north(m), AT[0] + 0.002, north(m + 50)], -1);
/** A z20 leaf at 60°N is about 19 m on a side: a tile may reach that much closer. */
const LEAF = 20;

const RISK = { threshold: 2, sigmaExtra: 0.3 };

function query(features: ChartFeature[], opts: QueryOptions = {}) {
  const store = buildPyramid(features, { minZoom: 12, leafZoom: 20 });
  return minDepthOver(store, footprintGeom([AT]), {
    bufferMetres: 10,
    chartPosition: true,
    risk: RISK,
    ...opts
  });
}

describe("chartWeight", () => {
  test("is 1 within the buffer and Φ(−gap/σ) beyond it", () => {
    expect(chartWeight(0, 250)).toBe(1);
    expect(chartWeight(-5, 0)).toBe(1);
    expect(chartWeight(250, 250)).toBeCloseTo(normalCdf(-1), 12);
    expect(chartWeight(10, 0)).toBe(0);
  });

  test("rises with σ, falls with the gap, and stops at the widest σ modelled", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 2000, noNaN: true }),
        fc.double({ min: 0.1, max: 2000, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (gap, sigma, more) => {
          expect(chartWeight(gap, sigma + more)).toBeGreaterThanOrEqual(chartWeight(gap, sigma));
          expect(chartWeight(gap + more, sigma)).toBeLessThanOrEqual(chartWeight(gap, sigma));
          expect(chartWeight(gap, sigma)).toBeLessThanOrEqual(0.5);
        }
      )
    );
    expect(chartWeight(500, 10_000)).toBe(chartWeight(500, MAX_CHART_SIGMA));
  });
});

describe("a tile beyond the buffer counts by its weight", () => {
  test.each<[Catzoc, number]>([
    [3, 25],
    [4, 250]
  ])("a drying area 60 m off under CATZOC %s (σP %s m)", (catzoc, sigmaP) => {
    const features = [coverage(BOX), quality(BOX, catzoc), area(BOX, 15), dryingNorth(60)];
    const r = query(features);
    // The footprint itself is 15 m water.
    expect(r.dMin).toBe(15);
    expect(r.coveredDMin).toBe(15);
    // 50 m beyond the 10 m buffer, a tile at most a leaf nearer.
    expect(r.maxRisk).toBeGreaterThanOrEqual(0.99 * normalCdf(-50 / sigmaP));
    expect(r.maxRisk).toBeLessThanOrEqual(normalCdf(-(50 - LEAF) / sigmaP));
    expect(r.riskTile?.dMin).toBe(-1);
    expect(r.riskTile?.chart).toMatchObject({ source: "survey", sigmaP });
    expect(r.riskTile?.chart?.distance).toBeGreaterThan(50 - LEAF);
    // Without the chart's position the 10 m buffer stops short of it.
    expect(query(features, { chartPosition: false }).maxRisk).toBeLessThan(1e-9);
  });

  test("an A1 survey keeps the same area's weight negligible", () => {
    const r = query([coverage(BOX), quality(BOX, 1), area(BOX, 15), dryingNorth(60)]);
    expect(r.maxRisk).toBeLessThan(RISK_STOP_BELOW);
  });

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
    expect(r.maxRisk).toBeLessThan(RISK_STOP_BELOW);
    // The same rock under the C survey counts by its weight, not in full.
    const inC = query([coverage(BOX), quality(BOX, 4), area(BOX, 20), point(AT[0], north(60), 1)]);
    expect(inC.dMin).toBe(20);
    expect(inC.maxRisk).toBeGreaterThan(0.3);
    expect(inC.maxRisk).toBeLessThan(0.5);
  });

  test.each([
    ["no survey quality", [] as ChartFeature[]],
    ["CATZOC U", [quality(BOX, 6)]],
    ["Traficom WFS water", [{ ...quality(BOX, 4), advisory: true }]]
  ])("%s spreads no depth; its flags still count", (_, zones) => {
    const advisory = zones.some((z) => z.advisory);
    const features = [
      { ...coverage(BOX), advisory },
      ...zones,
      { ...area(BOX, 15), advisory },
      { ...dryingNorth(60), advisory }
    ];
    const r = query(features);
    expect(r.dMin).toBe(15);
    expect(r.maxRisk).toBe(query(features, { chartPosition: false }).maxRisk);
    expect(r.riskTile?.chart).toBeUndefined();
    expect(r.flags & (FLAGS.UNASSESSED | FLAGS.NOT_FOR_NAVIGATION)).not.toBe(0);
  });

  test("a rock in unassessed water is still burned within k·σP of the unassessed survey", () => {
    const r = query([coverage(BOX), quality(BOX, 6), area(BOX, 15), point(AT[0], north(300), 1)]);
    expect(r.dMin).toBe(1);
  });

  test("flags count within 2σP of a tile's survey, and not beyond", () => {
    // A gap in coverage 300 m north: within 2σP of C (500 m), beyond 2σP of B (50 m).
    const hole = (catzoc: Catzoc) => [
      coverage([BOX[0], BOX[1], BOX[2], north(300)]),
      quality(BOX, catzoc),
      area(BOX, 15)
    ];
    expect(query(hole(4)).flags & FLAGS.NO_COVERAGE).not.toBe(0);
    expect(query(hole(3)).flags & FLAGS.NO_COVERAGE).toBe(0);
  });
});

describe("land and shoreline placed by their own accuracy", () => {
  // A shore 100 m north of AT, a 0.5 m strip 50 m wide along it, 6 m water elsewhere.
  const shore: Box = [22.0, north(100), 22.08, 60.04];
  const strip = area([22.0, north(50), 22.08, north(100)], 0.5);
  const placed = (f: DepthFeature, topoSigma?: number): DepthFeature =>
    topoSigma === undefined ? f : { ...f, topoSigma };
  const coast = (topoSigma?: number, withStrip = true): ChartFeature[] => [
    coverage(BOX),
    quality(BOX, 4),
    area(BOX, 6),
    ...(withStrip ? [strip] : []),
    placed(land(shore), topoSigma)
  ];

  test("land 100 m off with σ 6 m adds nothing; the strip still counts by the survey's σP", () => {
    const r = query(coast(6));
    expect(r.dMin).toBe(6);
    expect(r.riskTile?.chart?.source).toBe("survey");
    expect(r.riskTile?.dMin).toBe(0.5);
  });

  test("placed by the survey (an export without positional quality) land spreads as far as its zone", () => {
    // A steep shore: land 100 m off, 6 m water up to it.
    const own = query(coast(6, false));
    const legacy = query(coast(undefined, false));
    expect(own.maxRisk).toBe(query(coast(6, false), { chartPosition: false }).maxRisk);
    expect(legacy.riskTile?.chart?.source).toBe("survey");
    expect(legacy.riskTile?.dMin).toBe(-Infinity);
    expect(legacy.maxRisk).toBeGreaterThan(own.maxRisk);
  });

  test("land on a record not surveyed (QUAPOS 4) keeps its survey's σP", () => {
    const edge: ChartFeature = {
      role: "position",
      objectClass: "QUAPOS",
      geom: {
        type: "line",
        coords: [toMercator(22.0, north(100)), toMercator(22.08, north(100))]
      },
      cellRef: 0,
      band: 5,
      lowAccuracy: true
    };
    const r = query([...coast(6, false), edge]);
    expect(r.riskTile?.chart).toMatchObject({ source: "topography", sigmaP: 250 });
    expect(r.maxRisk).toBeCloseTo(query(coast(undefined, false)).maxRisk, 6);
  });

  test("a stated POSACC widens the shoreline's σ to half of it", () => {
    const edge: ChartFeature = {
      role: "position",
      objectClass: "QUAPOS",
      geom: { type: "point", p: toMercator(AT[0], north(100)) },
      cellRef: 0,
      band: 5,
      lowAccuracy: false,
      posacc: 200
    };
    const r = query([coverage(BOX), quality(BOX, 1), area(BOX, 6), placed(land(shore), 6), edge]);
    expect(r.riskTile?.chart).toMatchObject({ source: "topography", sigmaP: 100 });
  });

  test("the chart position columns survive a save and reload", () => {
    const store = buildPyramid(coast(6), { minZoom: 12, leafZoom: 20 });
    const opts = { bufferMetres: 10, chartPosition: true, risk: RISK };
    const before = minDepthOver(store, footprintGeom([AT]), opts);
    const after = minDepthOver(
      deserializePyramid(serializePyramid(store)),
      footprintGeom([AT]),
      opts
    );
    expect(after.maxRisk).toBeCloseTo(before.maxRisk, 12);
    expect(after.riskTile?.chart).toEqual(before.riskTile?.chart);
  });
});

describe("leaves only partly in an assessed survey", () => {
  test("a drying area in a leaf straddling B and U water counts from B water 40 m off", () => {
    // A z20 leaf the B/U boundary cuts in half; the patch lies in its B half.
    const at: [number, number] = [22.03, 60.015];
    const [mx, my] = toMercator(at[0], at[1]);
    const leaf = tileAt(20, mx, my);
    const r20 = tileRect(20, leaf.x, leaf.y);
    const [west, south] = fromMercator(r20.minX, r20.minY);
    const [east, top] = fromMercator(r20.maxX, r20.maxY);
    const seam = (west + east) / 2;
    const midLat = (south + top) / 2;
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
    const from: [number, number] = [patch[0] - 40 / M_PER_DEG_LON_AT, midLat];
    const r = minDepthOver(store, footprintGeom([from]), { chartPosition: true, risk: RISK });
    expect(r.maxRisk).toBeGreaterThanOrEqual(0.99 * normalCdf(-40 / 25));
    expect(r.riskTile?.dMin).toBe(-1);
  });
});

/**
 * Invariants 1 and 2 with graded chart position. Distances are measured in
 * a flat local frame and stretched slightly, so projection differences at
 * the boundary cannot decide.
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

const catzocArb = fc.constantFrom<Catzoc>(1, 2, 3, 4, 6);
const sceneArb = fc.record({
  zones: fc.tuple(catzocArb, catzocArb, catzocArb),
  areas: fc.array(fc.tuple(boxArb, fc.double({ min: -2, max: 25, noNaN: true })), {
    maxLength: 4
  }),
  query: boxArb,
  buffer: fc.double({ min: 0, max: 40, noNaN: true }),
  threshold: fc.double({ min: 0.5, max: 6, noNaN: true })
});

type Scene = typeof sceneArb extends fc.Arbitrary<infer T> ? T : never;

function strips(zones: Scene["zones"]): [Box, Catzoc][] {
  return zones.map((c, i): [Box, Catzoc] => [
    [W, S + (i * SPAN_LAT) / 3, W + SPAN_LON, S + ((i + 1) * SPAN_LAT) / 3],
    c
  ]);
}

function sceneStore(s: Scene) {
  const domain: Box = [W, S, W + SPAN_LON, S + SPAN_LAT];
  return buildPyramid(
    [
      coverage(domain),
      ...strips(s.zones).map(([b, c]) => quality(b, c)),
      area(domain, 30),
      ...s.areas.map(([b, d]) => area(b, d))
    ],
    { minZoom: 13, leafZoom: 17 }
  );
}

/** The least P(UKC < 0) a tile charted at depth d can carry, whatever σD its zones give it. */
function leastRisk(d: number, threshold: number): number {
  const sigmas = ([1, 2, 3, 4, 5, undefined] as const).map(
    (c) => sigmaFor(c, Math.max(0, d)).sigmaD
  );
  const sigma = (s: number) => Math.hypot(s, 0.3);
  return d < threshold
    ? normalCdf((threshold - d) / sigma(Math.max(...sigmas)))
    : normalCdf((threshold - d) / sigma(Math.min(...sigmas)));
}

describe("graded chart position (properties)", () => {
  test("invariant 1: dMin ≤ every area within the buffer; P ≥ P(area)·Φ(−g/σP) beyond it", () => {
    fc.assert(
      fc.property(sceneArb, (s) => {
        const store = sceneStore(s);
        const r = minDepthOver(store, footprintGeom(boxRing(s.query)), {
          bufferMetres: s.buffer,
          chartPosition: true,
          risk: { threshold: s.threshold, sigmaExtra: 0.3 }
        });
        let depth = 30;
        let risk = 0;
        for (const [b, d] of s.areas) {
          const g = boxDistance(b, s.query);
          if (g <= s.buffer * 0.98) {
            depth = Math.min(depth, d);
          }
          // The least σP of any strip the area touches; an unassessed one spreads nothing.
          const sigma = Math.min(
            ...strips(s.zones)
              .filter(([z]) => boxDistance(z, b) === 0)
              .map(([, c]) => SIGMA_P[c] ?? 0)
          );
          const beyond = Math.max(0, g * 1.02 - s.buffer);
          const weight = g <= s.buffer * 0.98 ? 1 : sigma > 0 ? chartWeight(beyond, sigma) : 0;
          risk = Math.max(risk, leastRisk(d, s.threshold) * weight);
        }
        expect(r.dMin).toBeLessThanOrEqual(depth);
        expect(r.maxRisk).toBeGreaterThanOrEqual(risk - RISK_STOP_BELOW);
      }),
      { numRuns: 150 }
    );
  });

  test("invariant 2: a wider buffer or a deeper draft never lowers P", () => {
    fc.assert(
      fc.property(
        sceneArb,
        fc.double({ min: 0, max: 60, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (s, more, deeper) => {
          const store = sceneStore(s);
          const p = (buffer: number, threshold: number) =>
            minDepthOver(store, footprintGeom(boxRing(s.query)), {
              bufferMetres: buffer,
              chartPosition: true,
              risk: { threshold, sigmaExtra: 0.3 }
            }).maxRisk;
          const base = p(s.buffer, s.threshold);
          expect(p(s.buffer + more, s.threshold)).toBeGreaterThanOrEqual(base - RISK_STOP_BELOW);
          expect(p(s.buffer, s.threshold + deeper)).toBeGreaterThanOrEqual(base - RISK_STOP_BELOW);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("chart position never lowers P: it only adds tiles beyond the buffer", () => {
    fc.assert(
      fc.property(sceneArb, (s) => {
        const store = sceneStore(s);
        const opts = { bufferMetres: s.buffer, risk: { threshold: s.threshold, sigmaExtra: 0.3 } };
        const geom = footprintGeom(boxRing(s.query));
        const graded = minDepthOver(store, geom, { ...opts, chartPosition: true });
        const plain = minDepthOver(store, geom, opts);
        expect(graded.maxRisk).toBeGreaterThanOrEqual(plain.maxRisk - RISK_STOP_BELOW);
        expect(graded.dMin).toBe(plain.dMin);
        expect(graded.coveredDMin).toBe(plain.coveredDMin);
      }),
      { numRuns: 100 }
    );
  });
});
