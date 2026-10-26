import fc from "fast-check";
import { normalCdf } from "../../src/foundation/stats";
import type { Catzoc, ChartFeature } from "../../src/ingest/features";
import { FLAGS } from "../../src/spatial/node-store";
import type { QueryOptions } from "../../src/spatial/pyramid";
import { footprintGeom, minDepthOver, RISK_STOP_BELOW } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { shadedWeight } from "../../src/spatial/survey-shadow";
import { uniform } from "../helpers/arbitraries";
import type { Box } from "../helpers/synthetic";
import { area, coverage, quality } from "../helpers/synthetic";

/**
 * Survey shadow (plan §4.3, issue #50): a tile beyond the buffer lies under
 * the footprint only if the water charted closer is off by its distance
 * too, so it counts with at most Φ(−r/S(r)) for every r up to its distance,
 * S(r) the widest survey σ within r.
 */

const M_PER_DEG_LAT = 111195;
const BOX: Box = [22.0, 60.0, 22.08, 60.04];
const AT: [number, number] = [22.03, 60.01];
const north = (m: number): number => AT[1] + m / M_PER_DEG_LAT;
/** A band of the box from `a` to `b` metres north of AT. */
const band = (a: number, b: number): Box => [BOX[0], north(a), BOX[2], north(b)];
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

/** 15 m water, CATZOC B to `edge` metres north of AT and D beyond, a drying bank 300 m north. */
function fairway(edge: number): ChartFeature[] {
  return [
    coverage(BOX),
    quality([BOX[0], BOX[1], BOX[2], north(edge)], 3),
    quality([BOX[0], north(edge), BOX[2], BOX[3]], 5),
    area(BOX, 15),
    area(band(300, 400), -0.5)
  ];
}

describe("a CATZOC D bank behind CATZOC B water", () => {
  test("in D water alone it counts by its own σ (±1000 m)", () => {
    const r = query([coverage(BOX), quality(BOX, 5), area(BOX, 15), area(band(300, 400), -0.5)]);
    expect(r.riskTile?.chart).toMatchObject({ source: "survey", sigmaP: 500 });
    expect(r.riskTile?.chart?.shadow).toBeUndefined();
    expect(r.maxRisk).toBeGreaterThan(0.25);
  });

  test("250 m of B water between keeps it from the keel", () => {
    // It lies under the keel only if the B survey (σ 25 m) is off by about 240 m.
    expect(query(fairway(250)).maxRisk).toBeLessThan(RISK_STOP_BELOW);
  });

  test("a narrow strip of B water bounds its weight and is named", () => {
    const r = query(fairway(40));
    const chart = r.riskTile?.chart;
    expect(chart).toMatchObject({ source: "survey", sigmaP: 500 });
    // The B strip ends about 30 m past the 10 m buffer, a leaf (≤ 20 m) either way.
    expect(chart?.shadow?.sigmaP).toBe(25);
    expect(chart?.shadow?.distance).toBeGreaterThan(10);
    expect(chart?.shadow?.distance).toBeLessThanOrEqual(30);
    const bound = normalCdf(-(chart?.shadow?.distance as number) / 25);
    expect(chart?.weight).toBeCloseTo(bound, 12);
    expect(chart?.weight).toBeLessThan(normalCdf(-(chart?.distance as number) / 500));
  });

  test("a coverage gap behind B water passes no flag; in D water alone it does", () => {
    const gap = (zones: ChartFeature[]): number =>
      query([coverage(band(-2000, 300)), ...zones, area(BOX, 15)]).flags & FLAGS.NO_COVERAGE;
    expect(gap([quality(BOX, 5)])).toBe(FLAGS.NO_COVERAGE);
    expect(gap([quality(band(-2000, 250), 3), quality(band(250, 2000), 5)])).toBe(0);
  });
});

describe("shadedWeight", () => {
  // Water 25 m wide placed with σ 25 m: it bounds a weight to Φ(−1) when read.
  const strip = () => ({ at: () => ({ ratio: 1, distance: 25, sigmaP: 25 }) }) as never;

  test("a tile at the buffer's edge counts in full: nothing lies between", () => {
    expect(shadedWeight(strip, 0, 500, 0.9, 0)).toEqual({ risk: 0.9, weight: 1 });
  });

  test("beyond it the weight is the smaller of its own and the shadow's", () => {
    const bounded = shadedWeight(strip, 10, 500, 0.9, 0);
    expect(bounded.weight).toBe(normalCdf(-1));
    expect(bounded.risk).toBe(0.9 * normalCdf(-1));
    expect(bounded.shadow).toEqual({ distance: 25, sigmaP: 25 });
    // Its own Φ(−10/5) is already smaller.
    expect(shadedWeight(strip, 10, 5, 0.9, 0).shadow).toBeUndefined();
  });
});

describe("survey shadow (properties)", () => {
  const zoneArb = fc.tuple(
    uniform(-600, 600),
    uniform(20, 600),
    fc.integer({ min: 1, max: 5 }).map((c) => c as Catzoc)
  );
  const chartArb = fc.record({
    base: fc.integer({ min: 1, max: 5 }).map((c) => c as Catzoc),
    zones: fc.array(zoneArb, { minLength: 1, maxLength: 3 }),
    banks: fc.array(fc.tuple(uniform(-600, 600), uniform(-1, 3)), { minLength: 1, maxLength: 3 }),
    pick: fc.nat(),
    worse: uniform(1.1, 20)
  });

  /** CATZOC position bounds (±, metres): a stated POSACC only widens them. */
  const BOUND: Record<Exclude<Catzoc, 6>, number> = { 1: 5, 2: 20, 3: 50, 4: 500, 5: 1000 };

  function chart(
    base: Catzoc,
    zones: [number, number, Catzoc][],
    banks: [number, number][],
    widen: { zone: number; factor: number } = { zone: -1, factor: 1 }
  ): ChartFeature[] {
    const placed = (box: Box, c: Catzoc, i: number): ChartFeature =>
      i === widen.zone
        ? { ...quality(box, c), posacc: BOUND[c as Exclude<Catzoc, 6>] * widen.factor }
        : quality(box, c);
    return [
      coverage(band(-3000, 3000)),
      placed(band(-3000, 3000), base, zones.length),
      ...zones.map(([at, width, c], i) => placed(band(at, at + width), c, i)),
      area(band(-3000, 3000), 15),
      ...banks.map(([at, depth]) => area(band(at, at + 30), depth))
    ];
  }

  // A worse CATZOC also widens σD, which lowers P for a depth already past the
  // threshold; a stated POSACC widens the position alone (σP), as invariant 2 reads.
  test("a worse chart position σ anywhere never lowers P or drops a flag (invariant 2)", () => {
    fc.assert(
      fc.property(chartArb, ({ base, zones, banks, pick, worse }) => {
        const before = query(chart(base, zones, banks));
        const widen = { zone: pick % (zones.length + 1), factor: worse };
        const after = query(chart(base, zones, banks, widen));
        // Either walk may overstate by up to RISK_STOP_BELOW where it prunes.
        expect(after.maxRisk).toBeGreaterThanOrEqual(before.maxRisk - RISK_STOP_BELOW);
        expect(before.flags & ~after.flags & (FLAGS.NO_COVERAGE | FLAGS.UNASSESSED)).toBe(0);
      }),
      { numRuns: 60 }
    );
  });

  test("the shadow never raises P: it only bounds weights", () => {
    fc.assert(
      fc.property(chartArb, ({ base, zones, banks }) => {
        const features = chart(base, zones, banks);
        const store = buildPyramid(features, { minZoom: 12, leafZoom: 20 });
        const r = minDepthOver(store, footprintGeom([AT]), {
          bufferMetres: 10,
          chartPosition: true,
          risk: RISK
        });
        const c = r.riskTile?.chart;
        const ok =
          c === undefined ||
          (c.weight <= normalCdf(-c.distance / c.sigmaP) + 1e-15 &&
            (c.shadow === undefined ||
              c.weight === normalCdf(-c.shadow.distance / c.shadow.sigmaP)));
        expect(ok).toBe(true);
      }),
      { numRuns: 60 }
    );
  });
});
