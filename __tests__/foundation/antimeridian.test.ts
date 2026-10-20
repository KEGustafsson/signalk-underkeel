import { splitLine, splitRing } from "../../src/foundation/antimeridian";
import type { LonLat } from "../../src/foundation/geo";

function area(ring: LonLat[]): number {
  let twice = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length] as LonLat;
    twice += p[0] * q[1] - q[0] * p[1];
  });
  return Math.abs(twice / 2);
}

describe("cutting at the antimeridian", () => {
  test("a line east across 180° is cut there, each part in [-180, 180]", () => {
    const parts = splitLine([
      [179.9, 10],
      [180.1, 11]
    ]);
    expect(parts).toEqual([
      [
        [179.9, 10],
        [180, 10.5]
      ],
      [
        [-180, 10.5],
        [-179.9, 11]
      ]
    ]);
  });

  test("a line west across -180° is cut there too", () => {
    const parts = splitLine([
      [-179.9, 0],
      [-180.1, 0],
      [-180.2, 0]
    ]);
    expect(parts.map((p) => p.map((q) => q[0]))).toEqual([
      [-179.9, -180],
      [180, expect.closeTo(179.9, 9), expect.closeTo(179.8, 9)]
    ]);
  });

  test("a line wholly past 180° moves whole; one inside stays as it is", () => {
    expect(
      splitLine([
        [180.5, 0],
        [181, 1]
      ])
    ).toEqual([
      [
        [-179.5, 0],
        [-179, 1]
      ]
    ]);
    const inside: LonLat[] = [
      [10, 0],
      [11, 1]
    ];
    expect(splitLine(inside)).toEqual([inside]);
  });

  test("a ring across 180° is cut into two parts of the same total area", () => {
    const ring: LonLat[] = [
      [179.8, 0],
      [180.2, 0],
      [180.2, 1],
      [179.8, 1]
    ];
    const parts = splitRing(ring);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.every((p) => p[0] >= -180 && p[0] <= 180)).toBe(true);
    }
    expect(parts.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(ring), 9);
  });

  test("a ring touching 180° from the west stays one part", () => {
    const ring: LonLat[] = [
      [179.8, 0],
      [180, 0],
      [180, 1],
      [179.8, 1]
    ];
    expect(splitRing(ring)).toEqual([ring]);
  });
});
