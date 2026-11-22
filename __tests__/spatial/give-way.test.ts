import type { ChartFeature } from "../../src/ingest/features";
import { giveWay } from "../../src/spatial/give-way";

/**
 * A cell's depth areas give way to its dredged areas covering a tile (`spatial/give-way.ts`):
 * the Traficom WFS cell's swept fairway areas over the depth area charting the channel.
 */

const square = {
  type: "polygon" as const,
  polygons: [
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0]
      ]
    ]
  ]
};

function depth(objectClass: string, d: number, cellRef = 0, more: object = {}): ChartFeature {
  return {
    objectClass,
    role: "depth",
    depth: d,
    hazard: false,
    dredged: objectClass === "DRGARE",
    geom: square,
    cellRef,
    band: 1,
    ...more
  } as unknown as ChartFeature;
}

const hit = (f: ChartFeature, full: boolean) => ({ item: { f }, full });
const classes = (hits: { item: { f: ChartFeature } }[]) => hits.map((h) => h.item.f.objectClass);
const never = () => false;

describe("depth areas giving way to dredged areas", () => {
  test("a dredged area containing the tile takes its cell's depth area off it", () => {
    const hits = [hit(depth("DEPARE", 0), true), hit(depth("DRGARE", 2.7), true)];
    expect(classes(giveWay(hits, never))).toEqual(["DRGARE"]);
  });

  test("soundings, rocks and land stay, and so do other cells' depth areas", () => {
    const sounding = depth("SOUNDG", 1.2, 0, { hazard: true });
    const other = depth("DEPARE", 0, 1);
    const hits = [
      hit(depth("DEPARE", 0), true),
      hit(depth("DRGARE", 2.7), true),
      hit(sounding, false),
      hit(depth("LNDARE", -Infinity), false),
      hit(other, true)
    ];
    expect(classes(giveWay(hits, never))).toEqual(["DRGARE", "SOUNDG", "LNDARE", "DEPARE"]);
  });

  test("a dredged area over part of the tile leaves the depth area, unless others cover it with it", () => {
    const hits = [
      hit(depth("DEPARE", 0), true),
      hit(depth("DRGARE", 2.7), false),
      hit(depth("DRGARE", 2.7), false)
    ];
    expect(classes(giveWay(hits, never))).toEqual(["DEPARE", "DRGARE", "DRGARE"]);
    expect(classes(giveWay(hits, () => true))).toEqual(["DRGARE", "DRGARE"]);
    // One partial area alone never covers the tile, whatever `covers` would say.
    expect(classes(giveWay(hits.slice(0, 2), () => true))).toEqual(["DEPARE", "DRGARE"]);
  });
});
