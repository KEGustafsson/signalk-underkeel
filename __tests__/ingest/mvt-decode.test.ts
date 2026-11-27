import { gzipSync } from "zlib";
import { decodeTile } from "../../src/ingest/mvt-decode";
import { tileBbox } from "../../src/ingest/odc";
import type { LonLatPoint } from "../helpers/mvt-encode";
import { encodeTile } from "../helpers/mvt-encode";

/** A z15 tile off Brittany, where an Open Data Charts unit lies. */
const ID = { z: 15, x: 15920, y: 11414 };
const [W, S, E, N] = tileBbox(ID);
/** The point at fractions `fx` east and `fy` north across the tile. */
const at = (fx: number, fy: number): LonLatPoint => [W + (E - W) * fx, S + (N - S) * fy];
/** A tile coordinate is 1/4096 of the tile; rounding moves a point half of that at most. */
const STEP = (E - W) / 4096;

function near(actual: unknown, expected: LonLatPoint): void {
  const [lon, lat] = actual as LonLatPoint;
  expect(Math.abs(lon - expected[0])).toBeLessThan(STEP);
  expect(Math.abs(lat - expected[1])).toBeLessThan(STEP);
}

const square = (fw: number, fs: number, fe: number, fn: number): LonLatPoint[] => [
  at(fw, fs),
  at(fe, fs),
  at(fe, fn),
  at(fw, fn),
  at(fw, fs)
];

describe("vector tile decoding", () => {
  const tile = encodeTile(ID, {
    SOUNDG: [{ point: [at(0.25, 0.5)], properties: { DEPTH: 12.4, OBJL: 129 } }],
    DEPCNT: [{ line: [[at(0, 0.1), at(0.5, 0.2), at(1, 0.1)]], properties: { VALDCO: 10 } }],
    DEPARE: [
      {
        polygon: [[square(0, 0, 1, 1), square(0.4, 0.4, 0.6, 0.6)]],
        properties: { DRVAL1: 5, DRVAL2: 10, INFORM: "Shom survey" }
      },
      { polygon: [[square(0, 0, 0.2, 0.2)], [square(0.8, 0.8, 1, 1)]], properties: { DRVAL1: -2 } }
    ]
  });

  test("points, lines and polygons come back in longitude and latitude with their attributes", () => {
    const layers = decodeTile(tile, ID);
    expect([...layers.keys()]).toEqual(["SOUNDG", "DEPCNT", "DEPARE"]);
    const [sounding] = layers.get("SOUNDG") ?? [];
    expect(sounding?.geometry?.type).toBe("Point");
    near(sounding?.geometry?.coordinates, at(0.25, 0.5));
    expect(sounding?.properties).toEqual({ DEPTH: 12.4, OBJL: 129 });

    const [contour] = layers.get("DEPCNT") ?? [];
    expect(contour?.geometry?.type).toBe("LineString");
    const line = contour?.geometry?.coordinates as LonLatPoint[];
    expect(line).toHaveLength(3);
    near(line[1], at(0.5, 0.2));
  });

  test("a hole stays with its polygon, and a second exterior ring starts a MultiPolygon", () => {
    const [holed, two] = decodeTile(tile, ID).get("DEPARE") ?? [];
    expect(holed?.geometry?.type).toBe("Polygon");
    const rings = holed?.geometry?.coordinates as LonLatPoint[][];
    expect(rings).toHaveLength(2);
    expect(rings[0]).toHaveLength(5);
    near(rings[1]?.[0], at(0.4, 0.4));
    expect(holed?.properties).toEqual({ DRVAL1: 5, DRVAL2: 10, INFORM: "Shom survey" });
    expect(two?.geometry?.type).toBe("MultiPolygon");
    expect(two?.geometry?.coordinates).toHaveLength(2);
    expect(two?.properties).toEqual({ DRVAL1: -2 });
  });

  test("only the layers asked for are read", () => {
    expect([...decodeTile(tile, ID, new Set(["DEPARE", "LNDARE"])).keys()]).toEqual(["DEPARE"]);
  });

  test("a gzipped tile, as MBTiles keep them, reads the same", () => {
    expect(decodeTile(new Uint8Array(gzipSync(tile)), ID)).toEqual(decodeTile(tile, ID));
  });

  test("a negative int64 value reads as its signed number", () => {
    const signed = encodeTile(ID, {
      SOUNDG: [{ point: [at(0.5, 0.5)], properties: { DEPTH: -3n, BIG: 2n ** 40n } }]
    });
    expect(decodeTile(signed, ID).get("SOUNDG")?.[0]?.properties).toEqual({
      DEPTH: -3,
      BIG: 2 ** 40
    });
  });

  test("a geometry sent in two packed parts reads as one, in wire order", () => {
    const feature = [0x18, 0x01, 0x22, 0x01, 0x09, 0x22, 0x02, 0x14, 0x28];
    const layer = [
      0x78,
      0x02,
      0x0a,
      0x01,
      0x4c,
      0x12,
      feature.length,
      ...feature,
      0x28,
      0x80,
      0x20
    ];
    const [point] = decodeTile(Uint8Array.from([0x1a, layer.length, ...layer]), ID).get("L") ?? [];
    near(point?.geometry?.coordinates, [W + ((E - W) * 10) / 4096, N - ((N - S) * 20) / 4096]);
  });

  test("a body that is not a whole vector tile throws", () => {
    expect(() => decodeTile(tile.subarray(0, tile.length - 7), ID)).toThrow(/vector tile/);
    expect(() => decodeTile(Uint8Array.from([0x1a, 0x05, 0x0f]), ID)).toThrow(/vector tile/);
    // Unknown fixed-width fields cut short.
    expect(() => decodeTile(Uint8Array.from([0x09, 1, 2, 3]), ID)).toThrow(/vector tile/);
    expect(() => decodeTile(Uint8Array.from([0x0d, 1, 2]), ID)).toThrow(/vector tile/);
  });
});
