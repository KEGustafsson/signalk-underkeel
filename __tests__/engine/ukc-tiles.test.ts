import fc from "fast-check";
import { tileAt, tileKey, tileRect, toMercator, fromMercator } from "../../src/foundation/geo";
import type { Thresholds } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import type { UkcTileInput } from "../../src/engine/ukc-tiles";
import { classify, ukcTile } from "../../src/engine/ukc-tiles";
import { FLAGS, NO_DATA } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { TileCell } from "../../src/spatial/tile-walk";
import { cellsInTile } from "../../src/spatial/tile-walk";
import { fixtureIndex, ROCK } from "../helpers/fixture-index";
import { area, basin, coverage, quality } from "../helpers/synthetic";

const TH: Thresholds = DEFAULT_LOOKAHEAD.thresholds;
const EXTENT = 4096;

function tileOf(z: number, lonLat: readonly [number, number]) {
  const [mx, my] = toMercator(lonLat[0], lonLat[1]);
  return { z, ...tileAt(z, mx, my) };
}

function input(threshold: number, degraded = false): UkcTileInput {
  return { threshold, sigmaExtra: 0.3, thresholds: TH, degraded };
}

describe("cells in a map tile", () => {
  const store = fixtureIndex().pyramid;

  test("cells tile the map tile exactly", () => {
    for (const z of [11, 14, 17, 20]) {
      const t = tileOf(z, ROCK);
      const cells = cellsInTile(store, t.z, t.x, t.y, z + 6);
      const area = cells.reduce((sum, c) => sum + 4 ** -(c.z - z), 0);
      expect(area).toBeCloseTo(1, 12);
      expect(cells.every((c) => c.z >= z && c.z <= Math.max(z, Math.min(z + 6, 18)))).toBe(true);
    }
  });

  test("a tile finer than its stored leaf is one cell with the leaf's values", () => {
    const uniform = buildPyramid(basin([22.0, 60.0, 22.4, 60.2], 7), {
      minZoom: 12,
      leafZoom: 20
    });
    const t = tileOf(19, [22.2, 60.1]);
    const [cell, ...rest] = cellsInTile(uniform, t.z, t.x, t.y, 25);
    expect(rest).toEqual([]);
    expect(cell).toMatchObject({ z: 19, x: t.x, y: t.y, values: { dMin: 7 } });
  });

  test("outside the index is no data", () => {
    const t = tileOf(14, [25, 61]);
    expect(cellsInTile(store, t.z, t.x, t.y, 20).map((c) => c.values)).toEqual([NO_DATA]);
  });

  test("a living-chart adjustment is folded into the cells it falls in, never drawn over them", () => {
    const uniform = buildPyramid(basin([22.0, 60.0, 22.4, 60.2], 7), {
      minZoom: 12,
      leafZoom: 18
    });
    const spot: [number, number] = [22.2, 60.1];
    const a = tileOf(uniform.adjustZoom, spot);
    // Shallower than the chart but with a narrower σ: alone it could class clearer.
    uniform.adjustments.set(tileKey(a.z, a.x, a.y), {
      dMin: 3,
      sigmaD: 0.01,
      sigmaP: 0,
      flags: FLAGS.LIVECHART_ADJUSTED,
      cellRef: -1
    });
    const contains = (o: TileCell, i: TileCell) =>
      o.z <= i.z && i.x >> (i.z - o.z) === o.x && i.y >> (i.z - o.z) === o.y;
    for (const [z, maxZoom] of [
      [11, 17],
      [14, 20],
      [18, 24],
      [19, 25]
    ] as const) {
      const t = tileOf(z, spot);
      const cells = cellsInTile(uniform, t.z, t.x, t.y, maxZoom);
      expect(cells.reduce((sum, c) => sum + 4 ** -(c.z - z), 0)).toBeCloseTo(1, 12);
      cells.forEach((c, i) =>
        cells.forEach((d, j) => expect(i === j || !contains(c, d)).toBe(true))
      );
      const hit = cells.filter((c) =>
        contains(c, { ...tileOf(maxZoom, spot), values: NO_DATA, bound: false })
      );
      expect(hit).toHaveLength(1);
      expect(hit[0]?.values).toMatchObject({ dMin: 3, flags: FLAGS.LIVECHART_ADJUSTED });
      expect(hit[0]?.values.sigmaD).toBeGreaterThan(0.01);
      expect(hit[0]?.bound).toBe(maxZoom < uniform.adjustZoom);
      expect(cells.filter((c) => c.values.dMin === 7).length).toBe(cells.length - 1);
    }
  });
});

describe("UKC classes", () => {
  test("classes follow P against the alert and warn thresholds", () => {
    const v = { dMin: 5, sigmaD: 0.3, sigmaP: 1, flags: 0, cellRef: 0 };
    expect(classify(v, input(2))).toBe("clear");
    expect(classify(v, input(4.2))).toBe("caution");
    expect(classify(v, input(5))).toBe("danger");
    expect(classify({ ...v, flags: 4 }, input(2))).toBe("unverified");
    expect(classify({ ...v, flags: 4 }, input(5))).toBe("danger");
    expect(classify(v, input(2, true))).toBe("unverified");
    expect(classify({ ...v, dMin: -Infinity }, input(2))).toBe("land");
    expect(classify(NO_DATA, input(2))).toBeUndefined();
    // A bound over land or a gap may also hold charted water: drawn, never hidden.
    expect(classify({ ...v, dMin: -Infinity }, input(2), true)).toBe("danger");
    expect(classify({ ...v, dMin: -Infinity, flags: 2 }, input(2), true)).toBe("unverified");
    // Past the threshold the bound's wide σ lowers P below a finer child's.
    const high: UkcTileInput = {
      ...input(13),
      thresholds: { alert: 0.5, warn: 0.62, alarm: 0.9 }
    };
    const wide = { ...v, dMin: 12, sigmaD: 4 };
    expect(classify(wide, high)).toBe("caution");
    expect(classify({ ...wide, sigmaD: 2.6 }, high)).toBe("danger");
    expect(classify(wide, high, true)).toBe("danger");
  });

  test("the rock in the fairway is danger for a 3.6 m threshold and clear water is not", () => {
    const t = tileOf(16, ROCK);
    const rects = ukcTile(fixtureIndex().pyramid, t.z, t.x, t.y, EXTENT, input(3.6));
    const classes = new Set(rects.map((r) => r.class));
    expect(classes.has("danger")).toBe(true);
    expect(classes.has("clear")).toBe(true);
    for (const r of rects) {
      expect(r.x0).toBeGreaterThanOrEqual(0);
      expect(r.x1).toBeLessThanOrEqual(EXTENT);
      expect(r.x1).toBeGreaterThan(r.x0);
    }
  });

  test("water beside the island is drawn at a coarse zoom, not hidden under land", () => {
    // The island's west shore is 22.025 E; this point is ~6 m off it. At z11
    // the drawing cell is z17, a split node that also holds land. (At the
    // leaf zoom a cell touching land is land: that is the index resolution.)
    const water: [number, number] = [22.0249, 60.0145];
    const store = fixtureIndex().pyramid;
    const t = tileOf(11, water);
    const tr = tileRect(t.z, t.x, t.y);
    const [mx, my] = toMercator(water[0], water[1]);
    const px = ((mx - tr.minX) / (tr.maxX - tr.minX)) * EXTENT;
    const py = ((tr.maxY - my) / (tr.maxY - tr.minY)) * EXTENT;
    const under = ukcTile(store, t.z, t.x, t.y, EXTENT, input(1)).filter(
      (r) => r.x0 <= px && px <= r.x1 && r.y0 <= py && py <= r.y1
    );
    expect(under.length).toBeGreaterThan(0);
    expect(under.every((r) => r.class !== "land")).toBe(true);
  });

  test("a fallback water level leaves nothing clear", () => {
    const t = tileOf(16, ROCK);
    const rects = ukcTile(fixtureIndex().pyramid, t.z, t.x, t.y, EXTENT, input(1, true));
    expect(rects.some((r) => r.class === "clear")).toBe(false);
    expect(rects.some((r) => r.class === "unverified")).toBe(true);
  });

  test.each([
    [3, "B"],
    [4, "C"]
  ] as const)(
    "water 60 m from a drying area under CATZOC %s (%s) is never drawn clear",
    (catzoc) => {
      // The patch may lie 50 m (B) or 500 m (C) from where it is drawn.
      const box = [22.0, 60.0, 22.06, 60.03] as const;
      const north = 60 / 111195;
      const store = buildPyramid(
        [
          coverage(box),
          quality(box, catzoc),
          area(box, 15),
          area([22.028, 60.015 + north, 22.032, 60.016 + north], -1)
        ],
        { minZoom: 12, leafZoom: 20 }
      );
      const at: [number, number] = [22.03, 60.015];
      const t = tileOf(14, at);
      const tr = tileRect(t.z, t.x, t.y);
      const [mx, my] = toMercator(at[0], at[1]);
      const px = ((mx - tr.minX) / (tr.maxX - tr.minX)) * EXTENT;
      const py = ((tr.maxY - my) / (tr.maxY - tr.minY)) * EXTENT;
      const rects = ukcTile(store, t.z, t.x, t.y, EXTENT, input(1.8));
      const under = rects.filter((r) => r.x0 <= px && px <= r.x1 && r.y0 <= py && py <= r.y1);
      expect(under.length).toBeGreaterThan(0);
      expect(under.every((r) => r.class === "danger")).toBe(true);
      // Far from the patch the water stays clear.
      expect(rects.some((r) => r.class === "clear")).toBe(true);
    }
  );

  test("an A1 survey keeps water 60 m from the same patch clear", () => {
    const box = [22.0, 60.0, 22.06, 60.03] as const;
    const north = 60 / 111195;
    const store = buildPyramid(
      [
        coverage(box),
        quality(box, 1),
        area(box, 15),
        area([22.028, 60.015 + north, 22.032, 60.016 + north], -1)
      ],
      { minZoom: 12, leafZoom: 20 }
    );
    const t = tileOf(14, [22.03, 60.015]);
    const tr = tileRect(t.z, t.x, t.y);
    const [mx, my] = toMercator(22.03, 60.015);
    const px = ((mx - tr.minX) / (tr.maxX - tr.minX)) * EXTENT;
    const py = ((tr.maxY - my) / (tr.maxY - tr.minY)) * EXTENT;
    const under = ukcTile(store, t.z, t.x, t.y, EXTENT, input(1.8)).filter(
      (r) => r.x0 < px && px < r.x1 && r.y0 < py && py < r.y1
    );
    expect(under.map((r) => r.class)).toEqual(["clear"]);
  });

  test("no point is riskier than the class drawn over it", () => {
    const store = fixtureIndex().pyramid;
    // Land is not drawn: it counts as danger only over a point that is itself land.
    const rank = { clear: 0, unverified: 1, caution: 1, danger: 2, land: 0 } as const;
    fc.assert(
      fc.property(
        fc.integer({ min: 11, max: 17 }),
        fc.double({ min: 22.001, max: 22.037, noNaN: true }),
        fc.double({ min: 60.001, max: 60.019, noNaN: true }),
        fc.double({ min: 1, max: 9, noNaN: true }),
        (z, lon, lat, threshold) => {
          const t = tileOf(z, [lon, lat]);
          const tr = tileRect(t.z, t.x, t.y);
          const rects = ukcTile(store, t.z, t.x, t.y, EXTENT, input(threshold));
          const [mx, my] = toMercator(lon, lat);
          const px = ((mx - tr.minX) / (tr.maxX - tr.minX)) * EXTENT;
          const py = ((tr.maxY - my) / (tr.maxY - tr.minY)) * EXTENT;
          const under = rects.filter((r) => r.x0 <= px && px <= r.x1 && r.y0 <= py && py <= r.y1);
          // As a route check or POST /query reads the point, chart position included.
          const at = minDepthOver(store, footprintGeom([fromMercator(mx, my)]), {
            chartReachK: 2,
            risk: { threshold, sigmaExtra: 0.3 }
          });
          const onLand = at.coveredDMin === -Infinity;
          if (onLand) {
            expect(under.some((r) => r.class === "land" || rank[r.class] === 2)).toBe(true);
          } else if (at.maxRisk >= TH.warn) {
            expect(under.some((r) => rank[r.class] === 2)).toBe(true);
          } else if (at.maxRisk >= TH.alert) {
            expect(under.some((r) => rank[r.class] >= 1)).toBe(true);
          }
        }
      ),
      { numRuns: 150 }
    );
  });
});
