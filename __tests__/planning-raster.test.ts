import fc from "fast-check";
import { parseConfig } from "../src/config";
import type { RouteCheckInput } from "../src/engine/route-check";
import { footprintStatus } from "../src/engine/route-check";
import { QUERY_WORK } from "../src/engine/work";
import type { LonLat } from "../src/foundation/geo";
import { fromMercator, tileAt, tileKey, tileRect, toMercator } from "../src/foundation/geo";
import type { RuleFeature } from "../src/ingest/rule-features";
import { hullBuffer } from "../src/model/vessel";
import { sigmaExtra, thresholdDepth } from "../src/model/uncertainty";
import { vesselTerms } from "../src/model/vessel";
import type { PlanningApiV1, Session } from "../src/planning-api";
import { FEATURES, planningApi } from "../src/planning-api";
import type { Raster } from "../src/planning-raster";
import { MAX_RASTER_CELLS, RASTER, RASTER_STATUS, sessionRaster } from "../src/planning-raster";
import type { RouteServiceDeps } from "../src/route-service";
import { RequestQueue } from "../src/route-service";
import type { CellInfo } from "../src/ingest/cells";
import type { ChartIndex } from "../src/spatial/chart-index";
import { countedCells } from "../src/spatial/chart-index";
import { HazardIndex } from "../src/spatial/hazards";
import { buildPyramid } from "../src/spatial/pyramid-build";
import { FLAGS, flagNames } from "../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../src/spatial/pyramid";
import { RuleIndex } from "../src/spatial/rules";
import { BANK, fixtureIndex, ROCK } from "./helpers/fixture-index";
import type { Box } from "./helpers/synthetic";
import { area, basin, coverage, land, point, quality } from "./helpers/synthetic";

/**
 * The planning session's raster (`planning-raster.ts`): each cell scored as a footprint that is
 * the cell alone, and what a planner may conclude of a leg from the cells near it.
 */

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3_600_000;
const WINDOW = { start: NOW, end: NOW + HOUR };
const VESSEL = { draft: 3.6, length: 12, beam: 4 };
const DYNAMICS = parseConfig({}).dynamics;

function input(over: Partial<RouteCheckInput> = {}): RouteCheckInput {
  return {
    coordinates: [],
    departure: NOW,
    speeds: [3],
    xteLimit: 30,
    hullBuffer: hullBuffer(VESSEL),
    vessel: VESSEL,
    dynamics: DYNAMICS,
    waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    highWater: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    probability: 0.01,
    ...over
  };
}

/** The block of `side` cells a side centred on `p`, at the index's raster zoom. */
function blockAt(index: ChartIndex, p: LonLat, side: number) {
  const z = index.pyramid.leafZoom;
  const [mx, my] = toMercator(p[0], p[1]);
  const t = tileAt(z, mx, my);
  return { x0: t.x - side / 2, y0: t.y - side / 2, cols: side, rows: side };
}

const statusOf = (r: Raster, k: number): string =>
  RASTER_STATUS[(r.cells[k] as number) & RASTER.STATUS] as string;

/** The cell's rectangle drawn in from its edges, so no other tile touches it. */
function inner(z: number, x: number, y: number): LonLat[] {
  const t = tileRect(z, x, y);
  const m = (t.maxX - t.minX) * 0.2;
  return [
    fromMercator(t.minX + m, t.minY + m),
    fromMercator(t.maxX - m, t.minY + m),
    fromMercator(t.maxX - m, t.maxY - m),
    fromMercator(t.minX + m, t.maxY - m)
  ];
}

describe("sessionRaster", () => {
  const index = fixtureIndex();
  const z = index.pyramid.leafZoom;

  test("each cell is scored as the walk scores the cell alone: status, stated risk and flags", () => {
    const i = input();
    const wl = i.waterLevel(NOW, NOW + HOUR, []);
    const terms = vesselTerms(i.vessel, {}, i.dynamics);
    const risk = { threshold: thresholdDepth(terms, wl), sigmaExtra: sigmaExtra(terms, wl) };
    const wrong: unknown[] = [];
    const seen = new Set<string>();
    for (const centre of [ROCK, BANK, [22.004, 60.01] as LonLat]) {
      const b = blockAt(index, centre, 48);
      const r = sessionRaster(index, i, WINDOW, b);
      for (let k = 0; k < r.cells.length; k += 5) {
        const [x, y] = [b.x0 + (k % b.cols), b.y0 + Math.floor(k / b.cols)];
        // Read down to the cell itself: a walk that stops at a coarser tile answers for all of it.
        const d = minDepthOver(index.pyramid, footprintGeom(inner(z, x, y)), {
          risk,
          clearAbove: Infinity
        });
        const land = d.coveredDMin === -Infinity;
        const charted = d.coveredDMin === Infinity || land ? null : d.coveredDMin;
        const want = {
          status: footprintStatus(d.maxRisk, charted, d.flags, land, i.probability),
          risky: Math.round(d.maxRisk * 10000) / 10000 >= i.probability,
          flags: [...flagNames(d.flags), ...(land ? ["LAND"] : [])].sort()
        };
        const got = {
          status: statusOf(r, k),
          risky: ((r.cells[k] as number) & RASTER.RISKY) !== 0,
          flags: [...(r.flagSets[r.flags[k] as number] as string[])].sort()
        };
        seen.add(got.status);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          wrong.push({ x, y, got, want });
        }
      }
    }
    expect(wrong.slice(0, 3)).toEqual([]);
    // The fixture's water, shoals and uncharted ground are all among the cells compared.
    expect([...seen]).toEqual(expect.arrayContaining(["fail", "ok", "unverified"]));
  });

  test("a cell is stuck when the window's highest water does not bring its P under the probability", () => {
    const b = blockAt(index, BANK, 64);
    const stuckAt = (h: number | undefined): number => {
      const r = sessionRaster(
        index,
        input({
          ...(h === undefined
            ? { highWater: undefined }
            : { highWater: () => ({ h, sigma: 0.3, source: "t" }) })
        }),
        WINDOW,
        b
      );
      let n = 0;
      for (let k = 0; k < r.cells.length; k++) {
        const c = r.cells[k] as number;
        n += c & RASTER.STUCK ? 1 : 0;
      }
      return n;
    };
    const same = stuckAt(0);
    const higher = stuckAt(6);
    const unknown = stuckAt(undefined);
    // Six metres more water opens the bank's shoals; land and uncharted ground stay stuck.
    expect(higher).toBeLessThan(same);
    expect(higher).toBeGreaterThan(0);
    // With no highest water known, only land and uncharted ground are stuck.
    expect(unknown).toBeLessThanOrEqual(higher);
  });

  test("stuck cells are those no cell passes at: none is ok", () => {
    const r = sessionRaster(index, input(), WINDOW, blockAt(index, BANK, 64));
    const okAndStuck = Array.from(r.cells).filter(
      (c) => (c & RASTER.STUCK) !== 0 && RASTER_STATUS[c & RASTER.STATUS] === "ok"
    );
    expect(okAndStuck).toEqual([]);
  });

  test("a fallback water level, a rule object and a living-chart sounding ask the exact check", () => {
    const b = blockAt(index, ROCK, 32);
    const asks = (r: Raster): number => Array.from(r.cells).filter((c) => c & RASTER.ASK).length;
    expect(asks(sessionRaster(index, input(), WINDOW, b))).toBe(0);
    const degraded = input({
      waterLevel: () => ({ h: 0, sigma: 0.5, source: "f", degraded: "no forecast" })
    });
    expect(asks(sessionRaster(index, degraded, WINDOW, b))).toBe(b.cols * b.rows);
    // A bridge across the block, and a navigation line, which no verdict reads.
    const line = (objectClass: RuleFeature["objectClass"]): RuleFeature => ({
      objectClass,
      geom: {
        type: "line",
        coords: [toMercator(ROCK[0] - 0.01, ROCK[1]), toMercator(ROCK[0] + 0.01, ROCK[1])]
      },
      cellRef: 0
    });
    const bridged = { ...index, rules: new RuleIndex([line("BRIDGE")]) };
    const n = asks(sessionRaster(bridged, input(), WINDOW, b));
    // The cells the bridge's box meets: a row of them, not the block.
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThanOrEqual(2 * b.cols);
    const lined = { ...index, rules: new RuleIndex([line("NAVLNE")]) };
    expect(asks(sessionRaster(lined, input(), WINDOW, b))).toBe(0);
    // A sounding of the boat's own under the rock's tile.
    const store = index.pyramid;
    const [mx, my] = toMercator(ROCK[0], ROCK[1]);
    const t = tileAt(store.adjustZoom, mx, my);
    const key = tileKey(store.adjustZoom, t.x, t.y);
    store.adjustments.set(key, {
      dMin: 2,
      sigmaD: 0.3,
      sigmaP: 3,
      flags: FLAGS.LIVECHART_ADJUSTED,
      cellRef: 0
    });
    try {
      expect(asks(sessionRaster(index, input(), WINDOW, b))).toBeGreaterThan(0);
    } finally {
      store.adjustments.delete(key);
    }
    expect(asks(sessionRaster(index, input(), WINDOW, b))).toBe(0);
  });

  test("a block painted is kept: asked again it costs one query's fixed work", () => {
    const b = blockAt(index, [22.03, 60.012], 64);
    const fresh = { ...index };
    const first = sessionRaster(fresh, input(), WINDOW, b);
    expect(first.work).toBeGreaterThan(QUERY_WORK);
    const again = sessionRaster(fresh, input(), WINDOW, b);
    expect(again.work).toBe(QUERY_WORK);
    expect(again.cells).toBe(first.cells);
    // Another draft is another raster.
    const deeper = sessionRaster(fresh, input({ vessel: { ...VESSEL, draft: 1 } }), WINDOW, b);
    expect(deeper.work).toBeGreaterThan(QUERY_WORK);
    expect(deeper.cells).not.toBe(first.cells);
  });

  test("a block that is empty, too large or off the tile grid is refused", () => {
    const ask = (x0: number, y0: number, cols: number, rows: number) => () =>
      sessionRaster(index, input(), WINDOW, { x0, y0, cols, rows });
    expect(ask(0, 0, 0, 4)).toThrow(RangeError);
    expect(ask(0, 0, 1.5, 4)).toThrow(RangeError);
    expect(ask(0, 0, MAX_RASTER_CELLS, 2)).toThrow(RangeError);
    expect(ask(-1, 0, 4, 4)).toThrow(RangeError);
    expect(ask(2 ** z - 2, 0, 4, 4)).toThrow(RangeError);
    expect(ask(0, 0, 4, 4)).not.toThrow();
  });
});

describe("the raster and a leg's verdict (property)", () => {
  /**
   * A well-surveyed chart (CATZOC A1 all over, so the chart's reach is metres, not the 1.9 km
   * of unassessed water): a 20 m basin with shoals, land and rocks in it.
   */
  const DOMAIN: Box = [22.0, 60.0, 22.04, 60.02];
  const index: ChartIndex = countedCells({
    catalogue: { version: 1, cells: [fixtureIndex().catalogue.cells[0] as CellInfo] },
    pyramid: buildPyramid(
      [
        coverage(DOMAIN),
        quality(DOMAIN, 1),
        ...basin(DOMAIN, 20),
        area([22.008, 60.004, 22.014, 60.008], 1.5),
        area([22.02, 60.011, 22.03, 60.013], 3),
        land([22.024, 60.004, 22.03, 60.007]),
        point(22.012, 60.014, 0.5),
        point(22.033, 60.016, 2)
      ],
      { minZoom: 12, leafZoom: 18 }
    ),
    hazards: new HazardIndex([]),
    rules: new RuleIndex([])
  });
  const z = index.pyramid.leafZoom;
  const deps: RouteServiceDeps = {
    index,
    indexReason: undefined,
    config: parseConfig({}),
    vessel: () => VESSEL,
    waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    highWater: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    getRoute: () => Promise.reject(new Error("no routes")),
    now: () => NOW,
    queue: new RequestQueue()
  };
  const api: PlanningApiV1 = planningApi(() => deps, "test");
  const NEVER = new AbortController().signal;

  test("the provider lists the feature, and a session serves blocks at its zoom", async () => {
    expect(FEATURES).toEqual(expect.arrayContaining(["raster", "held"]));
    const r = await api.session({ departure: NOW, until: NOW + HOUR, speed: 3 }, NEVER, (s) => {
      const before = s.work();
      const b = blockAt(index, [22.01, 60.01], 16);
      const raster = s.raster(b.x0, b.y0, b.cols, b.rows);
      return Promise.resolve({
        zoom: s.rasterZoom,
        z: raster.z,
        spent: s.work() - before,
        work: raster.work
      });
    });
    if (!r.ok) {
      throw new Error(r.error);
    }
    expect(r.value).toMatchObject({ zoom: z, z });
    expect(r.value.spent).toBe(r.value.work);
  });

  /** A point's cell coordinates at the raster's zoom. */
  const cellOf = (p: LonLat): [number, number] => {
    const [mx, my] = toMercator(p[0], p[1]);
    const t = tileRect(z, 0, 0);
    const size = t.maxX - t.minX;
    return [(mx - t.minX) / size, (t.maxY - my) / size];
  };
  /** A cell's ground size on the chart, metres. */
  const cellMetres =
    (tileRect(z, 0, 0).maxX - tileRect(z, 0, 0).minX) * Math.cos((60.01 * Math.PI) / 180);

  /** Distance from the segment a–b to the unit square at (x, y), cells, sampled along the leg. */
  function toCell(a: [number, number], b: [number, number], x: number, y: number): number {
    let d = Infinity;
    for (let k = 0; k <= 200; k++) {
      const px = a[0] + ((b[0] - a[0]) * k) / 200;
      const py = a[1] + ((b[1] - a[1]) * k) / 200;
      d = Math.min(d, Math.hypot(Math.max(x - px, 0, px - x - 1), Math.max(y - py, 0, py - y - 1)));
    }
    return d;
  }

  /** What the cells near the leg a → b say of it in session `s`. */
  function concluded(s: Session, a: LonLat, b: LonLat): { allOk: boolean; stuckInside: boolean } {
    const [ca, cb] = [cellOf(a), cellOf(b)];
    // Every cell the verdict can count: the corridor's rectangle, its corners √2 half-widths
    // from the leg's ends, and the chart's reach past it, with a cell to spare.
    const reach = s.raster(Math.floor(ca[0]), Math.floor(ca[1]), 1, 1).reach;
    const hold = (s.halfWidth * Math.SQRT2 * 1.02 + reach) / cellMetres + 1;
    const x0 = Math.floor(Math.min(ca[0], cb[0]) - hold);
    const y0 = Math.floor(Math.min(ca[1], cb[1]) - hold);
    const cols = Math.floor(Math.max(ca[0], cb[0]) + hold) - x0 + 1;
    const rows = Math.floor(Math.max(ca[1], cb[1]) + hold) - y0 + 1;
    const r = s.raster(x0, y0, cols, rows);
    const out = { allOk: true, stuckInside: false };
    for (let k = 0; k < r.cells.length; k++) {
      const c = r.cells[k] as number;
      const d = toCell(ca, cb, x0 + (k % cols), y0 + Math.floor(k / cols));
      if (d <= hold && (c & (RASTER.STATUS | RASTER.ASK)) !== 0) {
        out.allOk = false;
      }
      // Well inside the corridor: within half its width of the leg.
      const sure = (c & RASTER.STUCK) !== 0 && (c & (RASTER.ASK | RASTER.MIXED)) === 0;
      if (sure && d < (s.halfWidth * 0.5) / cellMetres) {
        out.stuckInside = true;
      }
    }
    return out;
  }

  test("a leg with every cell near it ok is ok; one with a stuck cell in its corridor is not", async () => {
    const leg = fc.tuple(
      fc.double({ min: 22.003, max: 22.037, noNaN: true }),
      fc.double({ min: 60.002, max: 60.018, noNaN: true }),
      fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
      fc.double({ min: 20, max: 500, noNaN: true })
    );
    const wrong: unknown[] = [];
    const counts = { passed: 0, failed: 0 };
    await api.session({ departure: NOW, until: NOW + HOUR, speed: 3, xteLimit: 10 }, NEVER, (s) => {
      fc.assert(
        fc.property(leg, ([lon, lat, brg, len]) => {
          const a: LonLat = [lon, lat];
          const b: LonLat = [
            lon + (len * Math.sin(brg)) / (111_320 * Math.cos((lat * Math.PI) / 180)),
            lat + (len * Math.cos(brg)) / 110_540
          ];
          const { allOk, stuckInside } = concluded(s, a, b);
          const v = s.segment(a, b);
          counts.passed += allOk ? 1 : 0;
          counts.failed += stuckInside ? 1 : 0;
          if ((allOk && v.status !== "ok") || (stuckInside && v.status === "ok")) {
            wrong.push({ a, b, allOk, stuckInside, v });
          }
        }),
        { numRuns: 400 }
      );
      return Promise.resolve();
    });
    expect(wrong.slice(0, 2)).toEqual([]);
    // Both conclusions are drawn often enough to mean something.
    expect(counts.passed).toBeGreaterThan(40);
    expect(counts.failed).toBeGreaterThan(20);
  });
});
