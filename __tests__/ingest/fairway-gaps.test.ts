import { fairwayGaps, HALF_MAX } from "../../src/ingest/fairway-gaps";
import type { WfsFeature } from "../../src/ingest/wfs-fetch";

/**
 * Gaps in a swept fairway (`ingest/fairway-gaps.ts`): two swept areas of a fairway, 40 m wide,
 * a 70 m gap between them where a bridge spans it, and the fairway's line through all three.
 */

const M = 1 / 111_320;
const K = 1 / (111_320 * Math.cos((60 * Math.PI) / 180));

/** A box `w` metres wide across the line y = 0, from x0 to x1 metres east of 22° E, 60° N. */
function area(id: string, x0: number, x1: number, w = 40, depth = 2.7): WfsFeature {
  const ring = [
    [22 + x0 * K, 60 - (w / 2) * M],
    [22 + x1 * K, 60 - (w / 2) * M],
    [22 + x1 * K, 60 + (w / 2) * M],
    [22 + x0 * K, 60 + (w / 2) * M],
    [22 + x0 * K, 60 - (w / 2) * M]
  ];
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { DRVAL1: depth, IDENTIFIER: id }
  };
}

const line = (draft?: number): WfsFeature => ({
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [22, 60],
      [22 + 400 * K, 60]
    ]
  },
  properties: { ...(draft !== undefined && { mitoitussyvays: draft }) }
});

describe("gaps in a swept fairway", () => {
  test("a gap under a bridge is bridged along the line, at the design draft, its width capped", () => {
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

  test("never deeper than either side was swept", () => {
    const gaps = fairwayGaps([line(3)], [area("A", 0, 150, 40, 2.4), area("B", 220, 400)]);
    expect(gaps[0]?.properties?.DRVAL1).toBe(2.4);
  });

  test("no strip over a long gap, without a design draft, or where one side is not swept", () => {
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
});
