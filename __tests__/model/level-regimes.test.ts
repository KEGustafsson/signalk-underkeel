import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import {
  fromMercator,
  haversine,
  offset,
  tileAt,
  tileRect,
  toMercator
} from "../../src/foundation/geo";
import type { AreaLevels } from "../../src/model/level-regimes";
import { levelOver, ringCorners, tileCorners, withinReach } from "../../src/model/level-regimes";
import type { WaterLevel } from "../../src/model/uncertainty";

const KEMI: LonLat = [24.52, 65.67];
const INSIDE: WaterLevel = { h: 0.62, sigma: 0.14, source: "fmi:forecast" };
const BEYOND: WaterLevel = { h: 0, sigma: 0.3, source: "fallback", degraded: "far" };
const REACH = { centre: KEMI, metres: 30000 };

const tileOf = (z: number, p: LonLat) => {
  const [mx, my] = toMercator(p[0], p[1]);
  return tileAt(z, mx, my);
};

describe("level regimes", () => {
  test("a tile holding the centre is within the reach; one past or across its edge is not", () => {
    const t = tileOf(14, KEMI);
    expect(withinReach(REACH, tileCorners(14, t.x, t.y))).toBe(true);
    const far = tileOf(14, offset(KEMI, 33000, 0));
    const corners = tileCorners(14, far.x, far.y);
    expect(Math.min(...corners.map((c) => haversine(c, KEMI)))).toBeGreaterThan(31000);
    expect(withinReach(REACH, corners)).toBe(false);
    const edge = tileOf(14, offset(KEMI, 30000, 0));
    const across = tileCorners(14, edge.x, edge.y).map((c) => haversine(c, KEMI));
    expect(Math.min(...across)).toBeLessThan(30000);
    expect(Math.max(...across)).toBeGreaterThan(30000);
    expect(withinReach(REACH, tileCorners(14, edge.x, edge.y))).toBe(false);
    expect(withinReach(REACH, [])).toBe(false);
  });

  test("the farthest point of a tile from any point is one of its corners", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 11, max: 16 }),
        fc.double({ min: 20, max: 30, noNaN: true }),
        fc.double({ min: 55, max: 70, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        (z, lon, lat, dLon, dLat) => {
          const t = tileOf(z, [lon, lat]);
          const p: LonLat = [lon + dLon, lat + dLat];
          const r = tileRect(z, t.x, t.y);
          const corners = Math.max(...tileCorners(z, t.x, t.y).map((c) => haversine(c, p)));
          let inner = 0;
          for (let i = 0; i < 50; i++) {
            for (let j = 0; j < 50; j++) {
              const q = fromMercator(
                r.minX + ((r.maxX - r.minX) * i) / 49,
                r.minY + ((r.maxY - r.minY) * j) / 49
              );
              inner = Math.max(inner, haversine(q, p));
            }
          }
          return inner <= corners + 1e-6;
        }
      ),
      { numRuns: 100 }
    );
  });

  test("without a beyond level the inside level holds everywhere", () => {
    const one: AreaLevels = { inside: INSIDE };
    expect(levelOver(one, tileCorners(14, 0, 0))).toBe(INSIDE);
    expect(levelOver(one, undefined)).toBe(INSIDE);
  });

  test("with a beyond level an area inside takes the inside level, any other the beyond level", () => {
    const two: AreaLevels = { inside: INSIDE, beyond: { level: BEYOND, reach: REACH } };
    const t = tileOf(14, KEMI);
    expect(levelOver(two, tileCorners(14, t.x, t.y))).toBe(INSIDE);
    const far = tileOf(14, offset(KEMI, 60000, 0));
    expect(levelOver(two, tileCorners(14, far.x, far.y))).toBe(BEYOND);
    expect(levelOver(two, undefined)).toBe(BEYOND);
  });

  test("a ring's box holds every vertex moved by the buffer in any direction", () => {
    const vertex = fc.tuple(
      fc.double({ min: -170, max: 170, noNaN: true }),
      fc.double({ min: -80, max: 80, noNaN: true })
    );
    fc.assert(
      fc.property(
        fc.array(vertex, { minLength: 3, maxLength: 8 }),
        fc.double({ min: 0, max: 5000, noNaN: true }),
        (ring, buffer) => {
          const box = ringCorners(ring, buffer);
          if (!box) {
            return Math.max(...ring.map((v) => v[0])) - Math.min(...ring.map((v) => v[0])) > 179;
          }
          const lons = box.map((c) => c[0]);
          const lats = box.map((c) => c[1]);
          const eps = 1e-9;
          return ring.every((v) =>
            [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
              const a = (k * Math.PI) / 4;
              const [lon, lat] = offset(v, buffer * Math.sin(a), buffer * Math.cos(a));
              return (
                lon >= Math.min(...lons) - eps &&
                lon <= Math.max(...lons) + eps &&
                lat >= Math.min(...lats) - eps &&
                lat <= Math.max(...lats) + eps
              );
            })
          );
        }
      ),
      { numRuns: 300 }
    );
  });

  test("a ring spanning more than 180° of longitude cannot be bounded; one across 180° unwrapped can", () => {
    expect(
      ringCorners(
        [
          [-100, 0],
          [100, 0],
          [100, 1]
        ],
        0
      )
    ).toBeUndefined();
    const across = ringCorners(
      [
        [179.9, 10],
        [180.1, 10],
        [180.1, 10.1]
      ],
      0
    );
    expect(across?.map((c) => c[0])).toEqual([179.9, 179.9, 180.1, 180.1]);
    expect(ringCorners([], 0)).toBeUndefined();
  });
});
