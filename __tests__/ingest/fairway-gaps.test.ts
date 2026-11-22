import { fairwayGaps, HALF_MAX } from "../../src/ingest/fairway-gaps";
import type { WfsFeature } from "../../src/ingest/wfs-fetch";

/**
 * Gaps in a swept fairway (`ingest/fairway-gaps.ts`): two swept areas of a fairway, 40 m wide,
 * a 70 m gap between them where a bridge spans it, and the fairway's line through all three.
 */

const M = 1 / 111_320;
const K = 1 / (111_320 * Math.cos((60 * Math.PI) / 180));

/** A ring from x0 to x1 and y0 to y1, metres east and north of 22° E, 60° N. */
const box = (x0: number, x1: number, y0: number, y1: number): number[][] => [
  [22 + x0 * K, 60 + y0 * M],
  [22 + x1 * K, 60 + y0 * M],
  [22 + x1 * K, 60 + y1 * M],
  [22 + x0 * K, 60 + y1 * M],
  [22 + x0 * K, 60 + y0 * M]
];

const feature = (
  id: string,
  rings: number[][][],
  depth = 2.7,
  vertaustaso = "MW2020"
): WfsFeature => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: rings },
  properties: { DRVAL1: depth, IDENTIFIER: id, vertaustaso }
});

/** A box `w` metres wide across the line y = 0, from x0 to x1 metres east of 22° E, 60° N. */
function area(id: string, x0: number, x1: number, w = 40, depth = 2.7): WfsFeature {
  return feature(id, [box(x0, x1, -w / 2, w / 2)], depth);
}

const line = (draft?: number, kept?: number, vertaustaso = "MW2020"): WfsFeature => ({
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [22, 60],
      [22 + 400 * K, 60]
    ]
  },
  properties: {
    ...(draft !== undefined && { mitoitussyvays: draft }),
    ...(kept !== undefined && { haraussyvyys: kept }),
    vertaustaso
  }
});

describe("gaps in a swept fairway", () => {
  test("a gap under a bridge is bridged along the line, at its design draft without a safe clearance depth, its width capped", () => {
    const gaps = fairwayGaps([line(2.1)], [area("A", 0, 150), area("B", 220, 400)]);
    expect(gaps).toHaveLength(1);
    const g = gaps[0] as WfsFeature;
    expect(g.properties).toEqual({ DRVAL1: 2.1, IDENTIFIER: "FTIA-GAP-A-B" });
    const ring = (g.geometry?.coordinates as number[][][])[0] as number[][];
    const ys = ring.map((p) => ((p[1] as number) - 60) / M);
    const xs = ring.map((p) => ((p[0] as number) - 22) / K);
    // HALF_MAX each side, though the areas are 20 m each side; and it reaches into both areas.
    expect(Math.max(...ys)).toBeCloseTo(HALF_MAX, 0);
    expect(Math.min(...ys)).toBeCloseTo(-HALF_MAX, 0);
    expect(Math.min(...xs)).toBeLessThan(150);
    expect(Math.max(...xs)).toBeGreaterThan(220);
  });

  test("at the line's safe clearance depth, not its design draft, so it never lowers a sweep", () => {
    // Route 3530 at Pargas: laid out for 2.1 m, kept clear to 2.7 m, swept to 2.7 m both sides.
    const gaps = fairwayGaps([line(2.1, 2.7)], [area("A", 0, 150), area("B", 220, 400)]);
    expect(gaps[0]?.properties?.DRVAL1).toBe(2.7);
    // Kept clear deeper than one side was swept: that side's depth.
    const deeper = fairwayGaps([line(2.1, 3)], [area("A", 0, 150, 40, 2.4), area("B", 220, 400)]);
    expect(deeper[0]?.properties?.DRVAL1).toBe(2.4);
  });

  test("never deeper than either side was swept", () => {
    const gaps = fairwayGaps([line(3)], [area("A", 0, 150, 40, 2.4), area("B", 220, 400)]);
    expect(gaps[0]?.properties?.DRVAL1).toBe(2.4);
  });

  test("no strip over a long gap, without a depth on the line, or where one side is not swept", () => {
    expect(fairwayGaps([line(2.1)], [area("A", 0, 100), area("B", 300, 400)])).toEqual([]);
    expect(fairwayGaps([line()], [area("A", 0, 150), area("B", 220, 400)])).toEqual([]);
    expect(fairwayGaps([line(2.1)], [area("A", 0, 150)])).toEqual([]);
  });

  test("a narrow area narrows the strip", () => {
    const gaps = fairwayGaps([line(2.1)], [area("A", 0, 150, 12), area("B", 220, 400)]);
    const ring = (gaps[0]?.geometry?.coordinates as number[][][])[0] as number[][];
    const ys = ring.map((p) => ((p[1] as number) - 60) / M);
    expect(Math.max(...ys)).toBeCloseTo(6, 0);
  });

  test("a line along the areas' edge gets no strip reaching past it", () => {
    // Both areas lie north of the line, from its y = 0 to 4 m.
    const north = (id: string, x0: number, x1: number) => feature(id, [box(x0, x1, 0, 4)]);
    expect(fairwayGaps([line(2.1)], [north("A", 0, 150), north("B", 220, 400)])).toEqual([]);
  });

  test("a gap ending on the areas' edge gets no strip outward of it, however wide further in", () => {
    // Both areas lie north of y = 0; the line runs 2 m inside them and meets their edge at the gap.
    const north = (id: string, x0: number, x1: number) => feature(id, [box(x0, x1, 0, 4)]);
    const bent: WfsFeature = {
      ...line(2.1),
      geometry: {
        type: "LineString",
        coordinates: [0, 140, 142, 228, 230, 400].map((x, i) => [
          22 + x * K,
          60 + (i === 2 || i === 3 ? 0 : 2) * M
        ])
      }
    };
    const gaps = fairwayGaps([bent], [north("A", 0, 150), north("B", 220, 400)]);
    const ys = gaps.flatMap((g) =>
      ((g.geometry?.coordinates as number[][][])[0] as number[][]).map(
        (p) => ((p[1] as number) - 60) / M
      )
    );
    expect(ys.filter((y) => y < -1e-6)).toEqual([]);
  });

  test("no strip across a hole in one area, nor where the line comes back into the same area", () => {
    const holed = feature("A", [box(0, 400, -20, 20), box(150, 220, -30, 30)]);
    expect(fairwayGaps([line(2.1)], [holed])).toEqual([]);
    const sides = {
      ...holed,
      geometry: {
        type: "MultiPolygon",
        coordinates: [[box(0, 150, -20, 20)], [box(220, 400, -20, 20)]]
      }
    };
    expect(fairwayGaps([line(2.1)], [sides as WfsFeature])).toEqual([]);
  });

  test("no strip across a hole in an area another area overlaps, in either order", () => {
    const holed = feature("A", [box(0, 400, -20, 20), box(150, 220, -30, 30)]);
    const over = area("B", 100, 150);
    for (const swept of [
      [over, holed],
      [holed, over]
    ]) {
      expect(fairwayGaps([line(2.1)], swept)).toEqual([]);
    }
  });

  test("the strip takes the least depth of every sweep holding the line where it leaves and enters", () => {
    const deep = area("A", 0, 150, 40, 2.7);
    const shallow = area("A2", 100, 150, 40, 1.8);
    for (const swept of [
      [deep, shallow, area("B", 220, 400)],
      [shallow, deep, area("B", 220, 400)]
    ]) {
      expect(fairwayGaps([line(2.4)], swept).map((g) => g.properties?.DRVAL1)).toEqual([1.8]);
    }
  });

  test("only where the line and the sweeps on both sides state the same reference level", () => {
    const swept = (b: string) => [
      area("A", 0, 150),
      feature("B", [box(220, 400, -20, 20)], 2.7, b)
    ];
    expect(fairwayGaps([line(2.1, 2.7, "Mw2020")], swept("MW2020 "))).toHaveLength(1);
    expect(fairwayGaps([line(2.1, 2.7)], swept("MW2005"))).toEqual([]);
    expect(fairwayGaps([line(2.1, 2.7, "N2000")], swept("N2000"))).toEqual([]);
    const unstated = { ...line(), properties: { haraussyvyys: 2.7 } };
    expect(fairwayGaps([unstated], swept("MW2020"))).toEqual([]);
    // An area that overlaps one side on another level counts too.
    const other = feature("A2", [box(100, 150, -20, 20)], 2.7, "MW2005");
    expect(fairwayGaps([line(2.1, 2.7)], [...swept("MW2020"), other])).toEqual([]);
  });

  test("a hole beside the line near the gap narrows the strip on its side, however wide further in", () => {
    // A hole 2–8 m north of the line, from 15 m to 1 m before the gap: the cross-sections from
    // 130 m in reach 10 m north, past it, and the strip reaches 10 m back into A.
    const holed = feature("A", [box(0, 150, -20, 20), box(135, 149, 2, 8)]);
    const gaps = fairwayGaps([line(2.1, 2.7)], [holed, area("B", 220, 400)]);
    expect(gaps).toHaveLength(1);
    const ring = (gaps[0]?.geometry?.coordinates as number[][][])[0] as number[][];
    const ys = ring.map((p) => ((p[1] as number) - 60) / M);
    expect(Math.max(...ys)).toBeLessThanOrEqual(2 + 1e-6);
    expect(Math.min(...ys)).toBeCloseTo(-HALF_MAX, 0);
  });

  test("a hole corner between two cross-sections narrows the strip too", () => {
    // A hole 0.6 m long, between the samples at 144 and 146 m, its nearest corner 3 m north.
    const corner = [
      [22 + 144.7 * K, 60 + 3 * M],
      [22 + 145.3 * K, 60 + 5 * M],
      [22 + 144.7 * K, 60 + 5 * M],
      [22 + 144.7 * K, 60 + 3 * M]
    ];
    const holed = feature("A", [box(0, 150, -20, 20), corner]);
    const gaps = fairwayGaps([line(2.1, 2.7)], [holed, area("B", 220, 400)]);
    const ring = (gaps[0]?.geometry?.coordinates as number[][][])[0] as number[][];
    expect(Math.max(...ring.map((p) => ((p[1] as number) - 60) / M))).toBeLessThanOrEqual(3 + 1e-6);
  });
});
