import fc from "fast-check";
import {
  fromMercator,
  groundToMercator,
  haversine,
  maxAbsLat,
  tileAt,
  tileRange,
  tileRect,
  tileSize,
  toMercator
} from "../../src/foundation/geo";

describe("web mercator", () => {
  test("round-trips lon/lat", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -84, max: 84, noNaN: true }),
        (lon, lat) => {
          const [x, y] = toMercator(lon, lat);
          const [lon2, lat2] = fromMercator(x, y);
          expect(lon2).toBeCloseTo(lon, 9);
          expect(lat2).toBeCloseTo(lat, 9);
        }
      )
    );
  });

  test("the tile containing a point contains it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 22 }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -84, max: 84, noNaN: true }),
        (z, lon, lat) => {
          const [x, y] = toMercator(lon, lat);
          const t = tileAt(z, x, y);
          const r = tileRect(z, t.x, t.y);
          expect(x).toBeGreaterThanOrEqual(r.minX - 1e-6);
          expect(x).toBeLessThanOrEqual(r.maxX + 1e-6);
          expect(y).toBeGreaterThanOrEqual(r.minY - 1e-6);
          expect(y).toBeLessThanOrEqual(r.maxY + 1e-6);
        }
      )
    );
  });

  test("tile size at z18 near 60°N is about 76 m on the ground", () => {
    const ground = tileSize(18) * Math.cos((60 * Math.PI) / 180);
    expect(ground).toBeGreaterThan(75);
    expect(ground).toBeLessThan(77);
  });

  test("tile range covers a rectangle's corners", () => {
    const [x0, y0] = toMercator(22, 60);
    const [x1, y1] = toMercator(22.1, 60.05);
    const range = tileRange(14, { minX: x0, minY: y0, maxX: x1, maxY: y1 });
    expect(range.minX).toBe(tileAt(14, x0, y1).x);
    expect(range.maxY).toBe(tileAt(14, x0, y0).y);
    expect(range.maxX).toBeGreaterThanOrEqual(range.minX);
  });

  test("ground buffers grow toward the pole", () => {
    // 1/(1 − e²) covers the WGS84 meridian radius, shortest at the equator.
    const stretch = 1.0067395;
    expect(groundToMercator(100, 0)).toBeCloseTo(100 * stretch, 4);
    expect(groundToMercator(100, 60)).toBeCloseTo(200 * stretch, 4);
    expect(groundToMercator(100, -60)).toBeCloseTo(200 * stretch, 4);
  });

  test("maxAbsLat picks the poleward edge", () => {
    const [, ys] = toMercator(0, 59);
    const [, yn] = toMercator(0, 61);
    expect(maxAbsLat({ minX: 0, maxX: 1, minY: ys, maxY: yn })).toBeCloseTo(61, 9);
  });

  test("haversine of one minute of latitude is about one nautical mile", () => {
    expect(haversine([22, 60], [22, 60 + 1 / 60])).toBeCloseTo(1853, -1);
  });
});
