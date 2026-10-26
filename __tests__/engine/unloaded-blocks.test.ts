import fc from "fast-check";
import type { NavState } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import { queryUkc } from "../../src/engine/query";
import type { LegStatus, RouteCheckInput } from "../../src/engine/route-check";
import { checkRoute } from "../../src/engine/route-check";
import type { UkcRect } from "../../src/engine/ukc-tiles";
import { ukcTile } from "../../src/engine/ukc-tiles";
import type { UnderKeelState } from "../../src/foundation/state";
import type { LonLat } from "../../src/foundation/geo";
import { tileAt, toMercator } from "../../src/foundation/geo";
import { DEFAULT_DYNAMICS, vesselTerms } from "../../src/model/vessel";
import { cacheOf } from "../../src/spatial/block-cache";
import type { ChartIndex } from "../../src/spatial/chart-index";
import type { BlockLayout } from "../../src/spatial/pyramid-blocks";
import { pyramidFromBuffer, serializePyramid } from "../../src/spatial/store";
import { uniform } from "../helpers/arbitraries";
import { CHART_DATUM, ctx } from "../helpers/engine";
import { FAIRWAY_LAT, fixtureIndex } from "../helpers/fixture-index";

/**
 * Safety invariant 3 with the pyramid read block by block (IX-11): wherever
 * a block is not loaded, every consumer answers at least as severely as with
 * it loaded, and a vessel, leg, query or tile over it is never `normal`,
 * `ok` or clear.
 */

const NOW = 1_800_000_000_000;
const FINE: BlockLayout = { residentZoom: 15, blockZoom: 13 };
const index = fixtureIndex();
const file = serializePyramid(index.pyramid, FINE);

/** The index with only the blocks whose bit is set in `mask` loaded; the rest never arrive. */
function partly(mask: number): ChartIndex {
  const pyramid = pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: -1 });
  const cache = cacheOf(pyramid);
  cache?.keys().forEach((key, i) => {
    if (mask & (1 << i)) {
      cache.loadNow(key);
    }
  });
  return { ...index, pyramid };
}

const ALL = 2 ** 30 - 1;
const lonArb = uniform(21.998, 22.042);
const latArb = uniform(59.984, 60.022);
const pointArb = fc.tuple(lonArb, latArb);
const maskArb = fc.integer({ min: 0, max: 15 });

test("the fixture has several blocks, and with all loaded the answers are the whole store's", () => {
  expect(cacheOf(partly(0).pyramid)?.size).toBeGreaterThanOrEqual(4);
  const at: NavState = {
    position: { value: [22.004, FAIRWAY_LAT], at: NOW },
    cog: { value: Math.PI / 2, at: NOW },
    sog: { value: 3, at: NOW }
  };
  const vessel = ctx({ draft: 3.2, length: 12, beam: 4 });
  expect(evaluateLookahead(at, vessel, partly(ALL), NOW)).toEqual(
    evaluateLookahead(at, vessel, index, NOW)
  );
});

describe("look-ahead", () => {
  const RANK: Record<UnderKeelState, number> = {
    normal: 0,
    unknown: 0,
    off: 0,
    alert: 1,
    warn: 2,
    alarm: 3
  };
  const run = (i: ChartIndex, p: LonLat, cog: number, sog: number, draft: number) =>
    evaluateLookahead(
      {
        position: { value: p, at: NOW },
        cog: { value: cog, at: NOW },
        sog: { value: sog, at: NOW },
        heading: { value: cog, at: NOW }
      },
      ctx({ draft, length: 12, beam: 4 }),
      i,
      NOW
    );

  test("an unloaded block never gives a less severe state than the loaded one", () => {
    fc.assert(
      fc.property(
        pointArb,
        uniform(0, 2 * Math.PI),
        uniform(0.5, 6),
        uniform(1, 4),
        maskArb,
        (p, cog, sog, draft, mask) => {
          const loaded = run(index, p, cog, sog, draft);
          const cold = run(partly(mask), p, cog, sog, draft);
          expect(RANK[cold.state]).toBeGreaterThanOrEqual(RANK[loaded.state]);
          // A block beyond the footprints' flag reach adds only its risk bound by its chart
          // position (plan §4.3), and as water whose survey is not read it shadows nothing: a
          // normal state reads every flag the loaded one does, and at least its risk. A coarse
          // footprint's hull may read more flags than the plan steps that decide the state.
          if (cold.state === "normal") {
            expect(loaded.state).toBe("normal");
            const dropped = loaded.footprints.map(
              (f, k) => f.flags & ~(cold.footprints[k]?.flags ?? 0)
            );
            expect(dropped.every((d) => d === 0)).toBe(true);
            expect(cold.risk ?? 0).toBeGreaterThanOrEqual((loaded.risk ?? 0) - 1e-4);
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  test("in the deep fairway with no block loaded it warns that there is no chart coverage", () => {
    const loaded = run(index, [22.004, FAIRWAY_LAT], Math.PI / 2, 2, 1.5);
    expect(loaded.state).toBe("normal");
    const cold = run(partly(0), [22.004, FAIRWAY_LAT], Math.PI / 2, 2, 1.5);
    expect(cold.state).toBe("warn");
    expect(cold.reason).toMatch(/no chart coverage/);
  });
});

describe("route check", () => {
  const RANK: Record<LegStatus, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };
  const input = (coordinates: LonLat[], draft: number): RouteCheckInput => ({
    coordinates,
    departure: NOW,
    speeds: coordinates.slice(1).map(() => 2.5),
    xteLimit: 20,
    planningBuffer: 10,
    vessel: { draft, length: 12, beam: 4 },
    dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => CHART_DATUM,
    probability: 0.01
  });

  test("an unloaded block never gives a leg a better status than the loaded one", () => {
    fc.assert(
      fc.property(
        fc.array(pointArb, { minLength: 2, maxLength: 4 }),
        uniform(1, 4),
        maskArb,
        (route, draft, mask) => {
          const loaded = checkRoute(index, input(route, draft), NOW).legs;
          const cold = checkRoute(partly(mask), input(route, draft), NOW).legs;
          cold.forEach((leg, i) => {
            const was = loaded[i] as (typeof loaded)[number];
            expect(RANK[leg.status]).toBeGreaterThanOrEqual(RANK[was.status]);
            // A block beyond the corridor's flag reach adds only its risk bound by its
            // chart position (plan §4.3): an ok leg reads the same flags, at least the risk.
            if (leg.status === "ok") {
              expect(leg.flags).toEqual(was.flags);
              expect(leg.charted).toBe(was.charted);
              expect(leg.risk).toBeGreaterThanOrEqual(was.risk - 1e-4);
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  test("the fairway leg that is ok loaded is unverified with no block loaded", () => {
    const fairway: LonLat[] = [
      [22.004, FAIRWAY_LAT],
      [22.03, FAIRWAY_LAT]
    ];
    expect(checkRoute(index, input(fairway, 1.5), NOW).legs[0]?.status).toBe("ok");
    const cold = checkRoute(partly(0), input(fairway, 1.5), NOW).legs[0];
    expect(cold?.status).not.toBe("ok");
    expect(cold?.flags).toContain("NO_COVERAGE");
  });
});

describe("query", () => {
  const RANK = { clear: 0, caution: 1, unverified: 2, danger: 3 } as const;
  const q = (i: ChartIndex, ring: LonLat[], draft: number, buffer: number) =>
    queryUkc(i, {
      ring,
      bufferMetres: buffer,
      terms: vesselTerms({ draft, length: 12, beam: 4 }, { speed: 0 }, DEFAULT_DYNAMICS),
      waterLevel: CHART_DATUM,
      thresholds: DEFAULT_LOOKAHEAD.thresholds
    });

  test("an unloaded block never gives a less severe class than the loaded one", () => {
    fc.assert(
      fc.property(
        pointArb,
        uniform(0, 0.004),
        uniform(1, 4),
        fc.constantFrom(0, 50, 300),
        maskArb,
        ([lon, lat], d, draft, buffer, mask) => {
          const ring: LonLat[] =
            d === 0
              ? [[lon, lat]]
              : [
                  [lon - d, lat - d / 2],
                  [lon + d, lat - d / 2],
                  [lon + d, lat + d / 2],
                  [lon - d, lat + d / 2]
                ];
          const loaded = q(index, ring, draft, buffer);
          const cold = q(partly(mask), ring, draft, buffer);
          expect(RANK[cold.class]).toBeGreaterThanOrEqual(RANK[loaded.class]);
          // A block beyond the query's flag reach adds only its risk bound by its chart
          // position (plan §4.3): a clear answer reads the same flags, at least the risk.
          if (cold.class === "clear") {
            expect(loaded.class).toBe("clear");
            expect(cold.flags).toEqual(loaded.flags);
            expect(cold.charted).toBe(loaded.charted);
            expect(cold.risk).toBeGreaterThanOrEqual(loaded.risk - 1e-4);
          }
        }
      ),
      {
        numRuns: 150,
        examples: [
          // From CI: a swept area beyond the buffer, inside a block not loaded, gave a clear
          // answer the SWEPT flag the loaded walk does not take from beyond the buffer.
          [[21.998, 60.021916399999995], 0.0019216, 2.6209, 0, 0]
        ]
      }
    );
  });

  test("open water that is clear loaded is unverified with no block loaded", () => {
    // The point's own leaves are in a block, so with none loaded it reads their stand-in.
    // (At 22.022, 60.0 the point's leaf is resident, and a block 330 m off lies behind
    // CATZOC B water, out of its flag reach under the survey shadow.)
    const p: LonLat = [22.022, 59.995];
    expect(q(index, [p], 1.5, 0).class).toBe("clear");
    expect(q(partly(0), [p], 1.5, 0).class).toBe("unverified");
  });

  test("a block only in chart reach adds its resident bound, not a coverage gap", () => {
    // The point's leaves are resident. A block around it counts by its chart position
    // (plan §4.3) with the bound of its resident node: its shallowest survey depth and
    // widest σ, which is at least the risk of any leaf in it, but its gap is beyond the
    // point's flag reach, as the loaded leaves' flags would be.
    const p: LonLat = [22.022, 60.005];
    const loaded = q(index, [p], 1.5, 0);
    const cold = q(partly(0), [p], 1.5, 0);
    expect(cold.class).toBe(loaded.class);
    expect(cold.flags).toEqual(loaded.flags);
    expect(cold.risk).toBeGreaterThanOrEqual(loaded.risk);
  });
});

describe("UKC tiles", () => {
  const RANK = { clear: 0, caution: 1, unverified: 2, danger: 3, land: 3 } as const;
  const SIDE = 64;
  const EXTENT = 4096;

  /** The class rank drawn at each of SIDE × SIDE points of the tile; -1 where nothing is. */
  function raster(rects: UkcRect[]): Int8Array {
    const out = new Int8Array(SIDE * SIDE).fill(-1);
    const step = EXTENT / SIDE;
    for (const r of rects) {
      for (let j = 0; j < SIDE; j++) {
        for (let i = 0; i < SIDE; i++) {
          const [px, py] = [(i + 0.5) * step, (j + 0.5) * step];
          if (px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1) {
            out[j * SIDE + i] = Math.max(out[j * SIDE + i] as number, RANK[r.class]);
          }
        }
      }
    }
    return out;
  }

  const draw = (i: ChartIndex, z: number, p: LonLat, threshold: number) => {
    const [mx, my] = toMercator(p[0], p[1]);
    const t = tileAt(z, mx, my);
    const input = { threshold, sigmaExtra: 0.3, thresholds: DEFAULT_LOOKAHEAD.thresholds };
    return raster(ukcTile(i.pyramid, z, t.x, t.y, EXTENT, { ...input, degraded: false }));
  };

  test("an unloaded block never draws a point less severe than the loaded one does", () => {
    fc.assert(
      fc.property(
        pointArb,
        fc.integer({ min: 11, max: 17 }),
        uniform(1, 6),
        maskArb,
        (p, z, threshold, mask) => {
          const loaded = draw(index, z, p, threshold);
          const cold = draw(partly(mask), z, p, threshold);
          // One assertion per run, not per point (§7 Test runtime); NaN still fails.
          const bad: Array<{ k: number; cold: number; loaded: number }> = [];
          cold.forEach((rank, k) => {
            const want = loaded[k] as number;
            if (!(rank >= want)) {
              bad.push({ k, cold: rank, loaded: want });
            }
          });
          expect({ count: bad.length, first: bad.slice(0, 10) }).toEqual({ count: 0, first: [] });
        }
      ),
      { numRuns: 80 }
    );
  });

  test("a fairway tile drawn clear loaded has no clear point with no block loaded", () => {
    const p: LonLat = [22.006, FAIRWAY_LAT];
    expect(draw(index, 16, p, 1.5)).toContain(RANK.clear);
    expect(draw(partly(0), 16, p, 1.5)).not.toContain(RANK.clear);
  });
});
