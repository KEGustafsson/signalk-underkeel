import { Validator } from "../helpers/json-schema";

/**
 * The crowdsourced depth cell format (docs/rfcs/crowdsourced-depth-cells.md):
 * an example a publisher could serve validates, and the fields a client
 * relies on are enforced.
 */

const v = new Validator();

const CELL = {
  quadkey: "120203002131230301",
  dMin: 2.1,
  dShoal: 2.3,
  dMedian: 2.8,
  spread: 0.3,
  sigmaZ: 0.25,
  sigmaXY: 5,
  nSoundings: 42,
  nPlatforms: 3,
  nDays: 4,
  tFirst: "2025-06-02T09:14:00Z",
  tLast: "2026-08-17T15:40:12Z",
  reduction: "model",
  ref: "surface",
  providers: ["SIGNALK"]
};

const SET = {
  apiVersion: "1",
  provider: "Example publisher",
  licence: "CC0-1.0",
  attribution: "Example attribution",
  edition: 7,
  issued: "2026-10-01T00:00:00Z",
  verdat: 23,
  leafZoom: 18,
  minZoom: 12,
  shoalQuantile: 0.05,
  bbox: [10.5, 57.5, 11.0, 57.8],
  sources: [{ name: "Example archive", url: "https://archive.example.org/" }]
};

describe("crowdsourced depth cells", () => {
  test("a leaf cell and a coarser cell without leaf-only fields validate", () => {
    expect(v.validate("csb-cell.json", CELL)).toEqual([]);
    const { dMedian: _m, spread: _s, ...parent } = CELL;
    expect(v.validate("csb-cell.json", { ...parent, quadkey: "120203002131" })).toEqual([]);
  });

  test("a set carries its cells inline, names a tileset, or both", () => {
    expect(v.validate("csb-cell-set.json", { ...SET, cells: [CELL] })).toEqual([]);
    expect(
      v.validate("csb-cell-set.json", {
        ...SET,
        tiles: { url: "https://tiles.example.org/csb/{z}/{x}/{y}.pbf", layer: "csb" }
      })
    ).toEqual([]);
    expect(
      v.validate("csb-cell-set.json", {
        ...SET,
        cells: [CELL],
        tiles: { url: "https://tiles.example.org/csb/{z}/{x}/{y}.pbf", layer: "csb" }
      })
    ).toEqual([]);
    expect(v.validate("csb-cell-set.json", SET)).toEqual([
      "$: matches no anyOf branch ($: missing cells; $: missing tiles)"
    ]);
  });

  test("a cell without soundings, a bad key or an unknown reduction is refused", () => {
    expect(
      v.validate("csb-cell.json", { ...CELL, quadkey: "1204", nSoundings: 0, reduction: "tide" })
    ).toEqual([
      '$.quadkey: "1204" does not match ^[0-3]{1,24}$',
      "$.nSoundings: 0 < 1",
      '$.reduction: "tide" not in ["gauge","model","none"]'
    ]);
    const { nPlatforms: _p, ...noPlatforms } = CELL;
    expect(v.validate("csb-cell.json", { ...noPlatforms, providers: [] })).toEqual([
      "$: missing nPlatforms",
      "$.providers: fewer than 1 items"
    ]);
  });

  test("a set's zoom range, quantile, cells and tile template are checked", () => {
    expect(
      v.validate("csb-cell-set.json", {
        ...SET,
        minZoom: 0,
        shoalQuantile: 0,
        tiles: { url: "https://tiles.example.org/csb.pbf", layer: "csb" },
        cells: [{ ...CELL, sigmaZ: -0.1 }]
      })
    ).toEqual([
      "$.minZoom: 0 < 1",
      "$.shoalQuantile: 0 ≤ 0",
      "$.cells[0].sigmaZ: -0.1 < 0",
      '$.tiles.url: "https://tiles.example.org/csb.pbf" does not match \\{z\\}.*\\{x\\}.*\\{y\\}'
    ]);
  });
});
