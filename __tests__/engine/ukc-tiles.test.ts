import fc from "fast-check";
import { tileAt, tileRect, toMercator, fromMercator } from "../../src/foundation/geo";
import type { Thresholds } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import type { UkcTileInput } from "../../src/engine/ukc-tiles";
import { classify, ukcTile } from "../../src/engine/ukc-tiles";
import { NO_DATA } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { cellsInTile } from "../../src/spatial/tile-walk";
import { fixtureIndex, ROCK } from "../helpers/fixture-index";
import { basin } from "../helpers/synthetic";

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
          const at = minDepthOver(store, footprintGeom([fromMercator(mx, my)]), {
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
