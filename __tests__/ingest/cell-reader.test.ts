import fs from "fs";
import os from "os";
import path from "path";
import { cellInfoFromDsid, readCellDirectory } from "../../src/ingest/cell-reader";
import { parseCatalogue, usageBandFromName } from "../../src/ingest/cells";
import type { ChartFeature } from "../../src/ingest/features";
import { hazardDepth, parseLayer, toParts } from "../../src/ingest/s57-geojson";

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "enc");

function byClass(features: ChartFeature[], objectClass: string) {
  return features.filter((f) => f.objectClass === objectClass);
}

describe("S-57 GeoJSON ingest", () => {
  const cell = readCellDirectory(path.join(FIXTURES, "FI5SYNTH"), 0);

  test("reads provenance from DSID", () => {
    expect(cell.info).toEqual({
      name: "FI5SYNTH",
      edition: 3,
      update: 1,
      issueDate: "20260101",
      band: 5,
      verticalDatum: 13,
      soundingDatum: 13
    });
  });

  test("maps object classes to roles", () => {
    const f = cell.features;
    expect(byClass(f, "M_COVR")[0]?.role).toBe("coverage");
    expect(byClass(f, "M_QUAL").map((q) => (q.role === "quality" ? q.catzoc : 0))).toEqual([2, 4]);
    expect(byClass(f, "SWPARE")[0]).toMatchObject({ role: "swept", depth: 8 });
    expect(byClass(f, "DEPARE").map((d) => (d.role === "depth" ? d.depth : NaN))).toEqual([10, 2]);
    expect(byClass(f, "LNDARE")[0]).toMatchObject({ role: "depth", depth: -Infinity });
    expect(byClass(f, "UWTROC")[0]).toMatchObject({
      role: "depth",
      depth: 3.5,
      hazard: true,
      lnam: "FI5-ROCK"
    });
  });

  test("splits 3-D sounding multipoints into point depths", () => {
    const soundings = byClass(cell.features, "SOUNDG");
    expect(soundings.map((s) => (s.role === "depth" ? s.depth : NaN))).toEqual([12.3, 1.8]);
    expect(soundings.every((s) => s.geom.type === "point")).toBe(true);
  });

  test("every feature carries its cell reference and band", () => {
    expect(cell.features.every((f) => f.cellRef === 0 && f.band === 5)).toBe(true);
  });

  test("band falls back to an override when the name has none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-cell-"));
    try {
      fs.copyFileSync(
        path.join(FIXTURES, "FI5SYNTH", "M_COVR.geojson"),
        path.join(dir, "M_COVR.geojson")
      );
      expect(() => readCellDirectory(dir, 0)).toThrow(/usage band/);
      expect(readCellDirectory(dir, 0, 3).info.band).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing directory or a cell without coverage is refused", () => {
    expect(() => readCellDirectory(path.join(FIXTURES, "missing-cell"), 0)).toThrow(
      /does not exist/
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "FI5EMPTY-"));
    try {
      expect(() => readCellDirectory(dir, 0, 5)).toThrow(/no M_COVR coverage/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hazard depth rules", () => {
  test("VALSOU wins, dry hazards are land, unknown depths are datum level", () => {
    expect(hazardDepth({ VALSOU: 2.1, WATLEV: 1 })).toBe(2.1);
    expect(hazardDepth({ VALSOU: "1.5" })).toBe(1.5);
    expect(hazardDepth({ WATLEV: 1 })).toBe(-Infinity);
    expect(hazardDepth({ WATLEV: 2 })).toBe(-Infinity);
    expect(hazardDepth({ WATLEV: 3 })).toBe(0);
    expect(hazardDepth({})).toBe(0);
  });
});

describe("layer parsing edge cases", () => {
  const ctx = { cellRef: 2, band: 4 };
  const fc = (geometry: unknown, properties: Record<string, unknown> = {}) => ({
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, geometry: geometry as never, properties }]
  });

  test("M_COVR with CATCOV 2 is not coverage", () => {
    const poly = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0]
        ]
      ]
    };
    expect(parseLayer("M_COVR", fc(poly, { CATCOV: 2 }), ctx)).toEqual([]);
    expect(parseLayer("M_COVR", fc(poly, { CATCOV: 1 }), ctx)).toHaveLength(1);
  });

  test("area classes ignore non-area geometry", () => {
    const line = {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1]
      ]
    };
    expect(parseLayer("DEPARE", fc(line, { DRVAL1: 3 }), ctx)).toEqual([]);
    expect(parseLayer("M_QUAL", fc(line, { CATZOC: 1 }), ctx)).toEqual([]);
    expect(parseLayer("SWPARE", fc(line, { DRVAL1: 3 }), ctx)).toEqual([]);
  });

  test("coastline is a land line; missing CATZOC is unassessed", () => {
    const line = {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [1, 1]
        ],
        [
          [2, 2],
          [3, 3]
        ]
      ]
    };
    const coast = parseLayer("COALNE", fc(line), ctx);
    expect(coast).toHaveLength(2);
    expect(coast[0]).toMatchObject({ role: "depth", depth: -Infinity, hazard: true });
    const poly = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0]
          ]
        ]
      ]
    };
    expect(parseLayer("M_QUAL", fc(poly), ctx)[0]).toMatchObject({ catzoc: 6 });
  });

  test("malformed coordinates are refused with the layer named, never turned into NaN", () => {
    const bad = [
      { type: "Point", coordinates: [] },
      { type: "Point", coordinates: ["22", 60] },
      { type: "Point", coordinates: [22, NaN] },
      { type: "MultiPoint", coordinates: "x" },
      {
        type: "LineString",
        coordinates: [
          [22, 60],
          [null, 60]
        ]
      },
      { type: "Polygon", coordinates: [] },
      { type: "Polygon", coordinates: [[]] },
      {
        type: "Polygon",
        coordinates: [
          [
            [22, 60],
            [22.1, 60],
            [22, 60]
          ]
        ]
      },
      {
        type: "Polygon",
        coordinates: [
          [
            [22, 60],
            [22.1, 60],
            [22.1, 60.1],
            [22, 60]
          ],
          [[22.05, 60.05]]
        ]
      },
      { type: "MultiPolygon", coordinates: [] },
      { type: "MultiPoint", coordinates: [] },
      { type: "LineString", coordinates: [[22, 60]] },
      { type: "MultiLineString", coordinates: [] }
    ];
    for (const geometry of bad) {
      expect(() => parseLayer("UWTROC", fc(geometry, { VALSOU: 1 }), ctx)).toThrow(
        /^UWTROC feature 0: /
      );
    }
  });

  test("unsupported geometries and null geometry yield nothing", () => {
    expect(toParts(null)).toEqual([]);
    expect(toParts({ type: "GeometryCollection" })).toEqual([]);
  });
});

describe("cell catalogue", () => {
  test("usage band comes from the third character of the name", () => {
    expect(usageBandFromName("FI5ABCDE")).toBe(5);
    expect(usageBandFromName("FI9ABCDE")).toBeUndefined();
    expect(usageBandFromName("synthetic")).toBeUndefined();
  });

  test("parses and validates cells.json", () => {
    const cat = parseCatalogue({ version: 1, cells: [{ name: "FI4X", edition: 2, update: 0 }] });
    expect(cat.cells[0]).toMatchObject({ name: "FI4X", band: 4, edition: 2 });
    expect(() => parseCatalogue({ version: 2, cells: [] })).toThrow(/version/);
    expect(() => parseCatalogue({ version: 1 })).toThrow(/cells array/);
    expect(() => parseCatalogue(null)).toThrow(/object/);
    expect(() => parseCatalogue({ version: 1, cells: [{ name: "x" }] })).toThrow(/usage band/);
    expect(() => parseCatalogue({ version: 1, cells: [null] })).toThrow(/not an object/);
    expect(() => parseCatalogue({ version: 1, cells: [{}] })).toThrow(/name/);
  });

  test("DSID without a dataset name falls back to the directory name", () => {
    expect(cellInfoFromDsid({}, "FI3ZZZ")).toMatchObject({ name: "FI3ZZZ", band: 3, edition: 0 });
  });
});
