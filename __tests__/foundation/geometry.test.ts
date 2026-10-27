import type { Rect } from "../../src/foundation/geo";
import type { Geom, PolygonGeom } from "../../src/foundation/geometry";
import { rectGap } from "../../src/foundation/geo";
import { REACH_SLACK } from "../../src/spatial/pyramid";
import fc from "fast-check";
import {
  areasCoverRect,
  SEAM_TOLERANCE,
  geomBounds,
  geomContainsRect,
  geomRectDistance,
  pointInPolygon,
  pointRectDistance,
  pointSegmentDistance,
  rectWithin,
  segmentIntersectsRect,
  segmentRectDistance
} from "../../src/foundation/geometry";

const square = (x0: number, y0: number, x1: number, y1: number) =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ] as const;

const donut: PolygonGeom = { outer: square(0, 0, 100, 100), holes: [square(40, 40, 60, 60)] };
const donutGeom: Geom = { type: "polygon", polygons: [donut] };
const r = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({
  minX,
  minY,
  maxX,
  maxY
});

describe("planar geometry", () => {
  test("point in polygon respects holes", () => {
    expect(pointInPolygon([10, 10], donut)).toBe(true);
    expect(pointInPolygon([50, 50], donut)).toBe(false);
    expect(pointInPolygon([150, 50], donut)).toBe(false);
  });

  test("point-segment and point-rect distances", () => {
    expect(pointSegmentDistance([5, 5], [0, 0], [10, 0])).toBe(5);
    expect(pointSegmentDistance([-3, 4], [0, 0], [10, 0])).toBe(5);
    expect(pointSegmentDistance([3, 4], [0, 0], [0, 0])).toBe(5);
    expect(pointRectDistance([13, 14], r(0, 0, 10, 10))).toBe(5);
    expect(pointRectDistance([5, 5], r(0, 0, 10, 10))).toBe(0);
  });

  test("sqrt distances stay within the query walk's slack of Math.hypot", () => {
    // Below 1e-3 m a square can go subnormal; no Mercator distance is that small and nonzero.
    const coord = fc
      .double({ min: -2e7, max: 2e7, noNaN: true })
      .filter((v) => v === 0 || Math.abs(v) > 1e-3);
    fc.assert(
      fc.property(coord, coord, coord, coord, (x, y, a, b) => {
        const rect = r(Math.min(a, b), Math.min(a, b), Math.max(a, b), Math.max(a, b));
        const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
        const dy = Math.max(rect.minY - y, 0, y - rect.maxY);
        const exact = Math.hypot(dx, dy);
        expect(pointRectDistance([x, y], rect)).toBeLessThanOrEqual(exact * REACH_SLACK);
        expect(rectGap(r(x, y, x, y), rect)).toBeLessThanOrEqual(exact * REACH_SLACK);
        const ex = x - a;
        const ey = y - b;
        expect(pointSegmentDistance([x, y], [a, b], [a, b])).toBeLessThanOrEqual(
          Math.hypot(ex, ey) * REACH_SLACK
        );
      }),
      { numRuns: 2000 }
    );
  });

  test("segment-rect intersection and distance", () => {
    expect(segmentIntersectsRect([-5, 5], [15, 5], r(0, 0, 10, 10))).toBe(true);
    expect(segmentIntersectsRect([-5, 15], [15, 15], r(0, 0, 10, 10))).toBe(false);
    expect(segmentIntersectsRect([20, 0], [20, 10], r(0, 0, 10, 10))).toBe(false);
    expect(segmentRectDistance([-5, 15], [15, 15], r(0, 0, 10, 10))).toBe(5);
    expect(segmentRectDistance([20, -50], [20, 50], r(0, 0, 10, 10))).toBe(10);
  });

  test("rect-polygon distance is zero on overlap, inside a hole it is the hole gap", () => {
    expect(geomRectDistance(donutGeom, r(5, 5, 6, 6))).toBe(0);
    expect(geomRectDistance(donutGeom, r(-10, -10, 200, 200))).toBe(0);
    expect(geomRectDistance(donutGeom, r(45, 45, 55, 55))).toBe(5);
    expect(geomRectDistance(donutGeom, r(110, 0, 120, 10))).toBe(10);
  });

  test("containment needs the whole rect inside one polygon, clear of holes", () => {
    expect(geomContainsRect(donutGeom, r(5, 5, 30, 30))).toBe(true);
    expect(geomContainsRect(donutGeom, r(30, 30, 50, 50))).toBe(false);
    expect(geomContainsRect(donutGeom, r(90, 90, 110, 110))).toBe(false);
    expect(geomContainsRect({ type: "point", p: [1, 1] }, r(0, 0, 2, 2))).toBe(false);
  });

  test("a rect is within a distance only when every point of it is", () => {
    expect(rectWithin(donutGeom, r(5, 5, 30, 30), 0)).toBe(true);
    expect(rectWithin(donutGeom, r(30, 30, 50, 50), 0)).toBe(false);
    expect(rectWithin(donutGeom, r(45, 45, 55, 55), 4)).toBe(false);
    expect(rectWithin(donutGeom, r(101, 10, 104, 20), 5)).toBe(true);
    expect(rectWithin(donutGeom, r(101, 10, 106, 20), 5)).toBe(false);
    const point: Geom = { type: "point", p: [0, 0] };
    expect(rectWithin(point, r(-3, -3, 3, 3), Math.hypot(3, 3))).toBe(true);
    expect(rectWithin(point, r(-3, -3, 3, 3), 4)).toBe(false);
    const line: Geom = {
      type: "line",
      coords: [
        [0, 0],
        [10, 0],
        [10, 10]
      ]
    };
    expect(rectWithin(line, r(2, -1, 8, 1), 1)).toBe(true);
    expect(rectWithin(line, r(2, -1, 8, 1), 0)).toBe(false);
  });

  test("lines and points", () => {
    const line: Geom = {
      type: "line",
      coords: [
        [0, 0],
        [10, 0],
        [10, 10]
      ]
    };
    expect(geomRectDistance(line, r(12, 4, 14, 6))).toBe(2);
    expect(geomRectDistance({ type: "point", p: [0, 0] }, r(3, 4, 5, 5))).toBe(5);
    expect(geomBounds(line)).toEqual(r(0, 0, 10, 10));
    expect(geomBounds(donutGeom)).toEqual(r(0, 0, 100, 100));
  });

  describe("areas covering a rect together", () => {
    const poly = (outer: readonly (readonly [number, number])[], holes = []): Geom => ({
      type: "polygon",
      polygons: [{ outer, holes }]
    });
    const west = poly(square(0, 0, 50, 100));
    const east = poly(square(50, 0, 100, 100));
    const across = r(45, 40, 55, 60);

    test("two polygons sharing an edge cover a rect across it", () => {
      expect(areasCoverRect([west, east], across)).toBe(true);
      expect(areasCoverRect([west], across)).toBe(false);
    });

    test("a diagonal shared edge, in either winding", () => {
      const lower = poly([
        [0, 0],
        [100, 0],
        [0, 100]
      ]);
      const upper = poly([
        [0, 100],
        [100, 100],
        [100, 0]
      ]);
      expect(areasCoverRect([lower, upper], r(45, 45, 55, 55))).toBe(true);
    });

    test("a hole filled by another polygon is covered", () => {
      expect(areasCoverRect([donutGeom, poly(square(40, 40, 60, 60))], r(35, 35, 45, 45))).toBe(
        true
      );
      expect(areasCoverRect([donutGeom], r(35, 35, 45, 45))).toBe(false);
    });

    test("an overlap or an edge split differently on each side covers", () => {
      expect(areasCoverRect([west, poly(square(49, 0, 100, 100))], across)).toBe(true);
      const split = poly([
        [50, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50, 50]
      ]);
      expect(areasCoverRect([west, split], across)).toBe(true);
      // Split differently and off the line by a few centimetres, as cells meet in practice.
      const off = poly([
        [50.03, 0],
        [100, 0],
        [100, 100],
        [50, 100],
        [50.02, 50]
      ]);
      expect(areasCoverRect([west, off], across)).toBe(true);
    });

    test("a gap wider than SEAM_TOLERANCE is not covered; one narrower is", () => {
      const beyond = 50 + 2 * SEAM_TOLERANCE;
      expect(areasCoverRect([west, poly(square(beyond, 0, 100, 100))], across)).toBe(false);
      expect(areasCoverRect([west, poly(square(51, 0, 100, 100))], across)).toBe(false);
      const within = 50 + SEAM_TOLERANCE / 2;
      expect(areasCoverRect([west, poly(square(within, 0, 100, 100))], across)).toBe(true);
      // A rect wholly in a narrow gap that no edge touches is not covered.
      const wide = poly(square(60, 0, 100, 100));
      expect(areasCoverRect([west, wide], r(52, 40, 58, 60))).toBe(false);
    });

    test("an edge the union keeps is not covered across, however split", () => {
      // Two polygons on the same side: the east edge at 50 bounds the union.
      const a = poly(square(0, 0, 50, 50));
      const b = poly(square(0, 50, 50, 100));
      expect(areasCoverRect([a, b], across)).toBe(false);
    });

    test("a spike into a gap does not cover it", () => {
      const spiked = poly([
        [0, 0],
        [50, 0],
        [50, 50],
        [60, 50],
        [50, 50],
        [50, 100],
        [0, 100]
      ]);
      expect(areasCoverRect([spiked, poly(square(60, 0, 100, 100))], r(52, 45, 58, 55))).toBe(
        false
      );
    });

    test("a rect reaching past the union is not covered", () => {
      expect(areasCoverRect([west, east], r(90, 40, 110, 60))).toBe(false);
      expect(areasCoverRect([west, east], r(200, 200, 210, 210))).toBe(false);
    });

    /**
     * Two polygons split the square along a random monotone polyline. When
     * they share it, every rect inside the square is covered; when one is
     * shifted, a true answer must still hold at every probed point.
     */
    test("property: true only when every point of the rect is in an area or a seam", () => {
      const cut = fc
        .uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: 0, maxLength: 6 })
        .chain((xs) =>
          fc.tuple(
            fc.constant([0, ...xs.sort((a, b) => a - b), 100]),
            fc.array(fc.integer({ min: 5, max: 95 }), {
              minLength: xs.length + 2,
              maxLength: xs.length + 2
            })
          )
        );
      const rect = fc
        .tuple(fc.integer({ min: 1, max: 98 }), fc.integer({ min: 1, max: 98 }))
        .chain(([x, y]) =>
          fc.tuple(
            fc.constant([x + 0.5, y + 0.5]),
            fc.integer({ min: 0, max: 99 - x }),
            fc.integer({ min: 0, max: 99 - y })
          )
        );
      fc.assert(
        fc.property(
          cut,
          rect,
          fc.integer({ min: -2, max: 2 }),
          ([xs, ys], [[x, y], w, h], shift) => {
            const line = xs.map((cx, i) => [cx, ys[i] as number] as const);
            const moved = line.map(([cx, cy]) => [cx, cy + shift] as const);
            const lower = poly([[0, 0], [100, 0], ...[...line].reverse()]);
            const upper = poly([...moved, [100, 100], [0, 100]]);
            const box = r(x, y, x + w, y + h);
            const got = areasCoverRect([lower, upper], box);
            if (shift === 0) {
              expect(got).toBe(true);
            }
            if (!got) {
              return;
            }
            for (let i = 0; i <= 4; i++) {
              for (let j = 0; j <= 4; j++) {
                const p = [x + (w * i) / 4 + 1e-7, y + (h * j) / 4 + 1e-7] as const;
                // A point on the shared edge is in both areas; pointInPolygon alone
                // may count it in neither. A point in a seam no wider than
                // SEAM_TOLERANCE lies within it of an area.
                const inside = [lower, upper].some(
                  (g) => geomRectDistance(g, r(p[0], p[1], p[0], p[1])) <= SEAM_TOLERANCE + 1e-9
                );
                expect(inside).toBe(true);
              }
            }
          }
        ),
        { numRuns: 500 }
      );
    });
  });
});
