import type { Rect } from "../../src/foundation/geo";
import type { Geom, PolygonGeom } from "../../src/foundation/geometry";
import {
  geomBounds,
  geomContainsRect,
  geomRectDistance,
  pointInPolygon,
  pointRectDistance,
  pointSegmentDistance,
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
});
