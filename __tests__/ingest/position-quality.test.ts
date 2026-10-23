import fs from "fs";
import os from "os";
import path from "path";
import { readCellDirectory, readCellInfo } from "../../src/ingest/cell-reader";
import { compilationSigma, parseCatalogue } from "../../src/ingest/cells";
import type { ChartFeature, DepthFeature, PositionFeature } from "../../src/ingest/features";
import { parseLayer, POSITION_LAYER, TOPOGRAPHY } from "../../src/ingest/s57-geojson";

/**
 * Positional quality of the shoreline (plan §4.4): the compilation scale
 * from DSID and the spatial records whose position is not surveyed, from
 * QUAPOS.geojson as the gdal3.js reader builds it from the primitive layers.
 */

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "enc");

let dir: string;

function writeJson(name: string, json: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(json));
}

function dsid(props: Record<string, unknown>): void {
  writeJson("DSID.geojson", {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: null, properties: props }]
  });
}

const point = (c: number[]) => ({ type: "Point", coordinates: c });
const feature = (properties: Record<string, unknown>, geometry: unknown) => ({
  type: "Feature",
  properties,
  geometry
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "position-quality-"));
  const src = path.join(FIXTURES, "FI5SYNTH");
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  dsid({ DSID_DSNM: "FI5SYNTH.000", DSID_EDTN: "3", DSID_UPDN: "1", DSPM_CSCL: 12000 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const depthFeatures = (fs: ChartFeature[]): DepthFeature[] =>
  fs.filter((f): f is DepthFeature => f.role === "depth");

describe("compilation scale and positional quality", () => {
  test("1 mm at the compilation scale is a 95 % bound: σ = scale / 2000 m", () => {
    expect(compilationSigma(12000)).toBe(6);
    expect(compilationSigma(45000)).toBe(22.5);
  });

  test("an export without QUAPOS.geojson keeps every object on the survey's position", () => {
    const cell = readCellDirectory(dir, 0);
    expect(cell.info.compilationScale).toBe(12000);
    expect(cell.info.positionQuality).toBeUndefined();
    expect(depthFeatures(cell.features).every((f) => f.topoSigma === undefined)).toBe(true);
  });

  test("with QUAPOS.geojson land, shoreline and depth areas take the scale's σ", () => {
    writeJson("QUAPOS.geojson", { type: "FeatureCollection", features: [] });
    const cell = readCellDirectory(dir, 0);
    expect(cell.info.positionQuality).toBe(true);
    const depths = depthFeatures(cell.features);
    const drawn = depths.filter(
      (f) =>
        TOPOGRAPHY.has(f.objectClass) || f.objectClass === "DEPARE" || f.objectClass === "DRGARE"
    );
    expect(drawn.some((f) => TOPOGRAPHY.has(f.objectClass))).toBe(true);
    expect(drawn.some((f) => f.objectClass === "DEPARE")).toBe(true);
    expect(drawn.every((f) => f.topoSigma === 6)).toBe(true);
    // Soundings and rocks stay on their survey.
    const points = depths.filter((f) => !drawn.includes(f));
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((f) => f.topoSigma === undefined && f.geom.type === "point")).toBe(true);
    expect(cell.features.filter((f) => f.role !== "depth").every((f) => !("topoSigma" in f))).toBe(
      true
    );
  });

  test("without a compilation scale the shoreline keeps the survey's position", () => {
    dsid({ DSID_DSNM: "FI5SYNTH.000", DSID_EDTN: "3", DSID_UPDN: "1" });
    writeJson("QUAPOS.geojson", { type: "FeatureCollection", features: [] });
    const cell = readCellDirectory(dir, 0);
    expect(depthFeatures(cell.features).every((f) => f.topoSigma === undefined)).toBe(true);
  });

  test("cells.json keeps the compilation scale and positional quality", () => {
    writeJson("QUAPOS.geojson", { type: "FeatureCollection", features: [] });
    const info = { ...readCellInfo(dir), band: 5 };
    const back = parseCatalogue(JSON.parse(JSON.stringify({ version: 1, cells: [info] })));
    expect(back.cells[0]).toMatchObject({ compilationScale: 12000, positionQuality: true });
  });
});

describe("M_CSCL areas compiled at another scale", () => {
  const rect = ([w, s, e, n]: number[]) => ({
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s]
      ]
    ]
  });
  const mcscl = (...areas: [number, number[]][]) =>
    writeJson("M_CSCL.geojson", {
      type: "FeatureCollection",
      features: areas.map(([CSCALE, box]) => feature({ CSCALE }, rect(box)))
    });
  const drawnOf = (cls: string) =>
    depthFeatures(readCellDirectory(dir, 0).features).filter((f) => f.objectClass === cls);

  beforeEach(() => {
    // A low-accuracy node by the 2 m bank (22.01–22.015, 59.988–59.991).
    writeJson("QUAPOS.geojson", {
      type: "FeatureCollection",
      features: [feature({ PRIM: "inode", RCID: 1, QUAPOS: 4 }, point([22.012, 59.989]))]
    });
  });

  test("what the drawing places in a 1:80 000 area takes its σ (40 m), not DSPM_CSCL's", () => {
    mcscl([80000, [22.009, 59.987, 22.016, 59.992]]);
    const cell = readCellDirectory(dir, 0);
    const areas = drawnOf("DEPARE");
    expect(areas.length).toBeGreaterThan(1);
    // Every depth area meeting the 1:80 000 area by box, the 10 m one around it too.
    expect(areas.every((f) => f.topoSigma === 40 && f.scale === 80000)).toBe(true);
    // Land away from it keeps the cell's 1:12 000.
    expect(drawnOf("LNDARE").every((f) => f.topoSigma === 6 && f.scale === 12000)).toBe(true);
    const node = cell.features.find((f): f is PositionFeature => f.role === "position");
    expect(node?.scale).toBe(80000);
    // Soundings and rocks stay on their survey.
    expect(
      depthFeatures(cell.features)
        .filter((f) => f.hazard)
        .every((f) => f.topoSigma === undefined)
    ).toBe(true);
  });

  test("an area at a larger scale than the cell's never narrows the σ", () => {
    mcscl([5000, [21.9, 59.9, 22.1, 60.1]]);
    expect(drawnOf("DEPARE").every((f) => f.topoSigma === 6 && f.scale === 12000)).toBe(true);
  });

  test("an M_CSCL area is no chart feature", () => {
    mcscl([80000, [22.009, 59.987, 22.016, 59.992]]);
    expect(readCellDirectory(dir, 0).features.some((f) => f.objectClass === "M_CSCL")).toBe(false);
  });
});

describe("QUAPOS.geojson records", () => {
  const ctx = { cellRef: 0, band: 5, topoSigma: 6 };
  const positions = (features: unknown[]): PositionFeature[] =>
    parseLayer(POSITION_LAYER, { type: "FeatureCollection", features } as never, ctx).filter(
      (f): f is PositionFeature => f.role === "position"
    );

  test("an edge is rebuilt whole from its connected nodes, GDAL's interior vertices between", () => {
    const [edge] = positions([
      feature(
        { PRIM: "edge", RCID: 1, QUAPOS: 4, NODE0: 10, NODE1: 11 },
        { type: "LineString", coordinates: [[22.01, 60.01]] }
      ),
      feature({ PRIM: "cnode", RCID: 10, QUAPOS: null }, point([22.0, 60.0])),
      feature({ PRIM: "cnode", RCID: 11, QUAPOS: null }, point([22.02, 60.02]))
    ]);
    expect(edge?.lowAccuracy).toBe(true);
    expect(edge?.geom.type).toBe("line");
    expect(edge?.geom.type === "line" && edge.geom.coords.length).toBe(3);
  });

  test("an edge without interior vertices (GDAL writes it empty) is the segment between its nodes", () => {
    const [edge] = positions([
      feature(
        { PRIM: "edge", RCID: 1, QUAPOS: 4, NODE0: 10, NODE1: 11 },
        { type: "LineString", coordinates: [] }
      ),
      feature({ PRIM: "cnode", RCID: 10 }, point([22.0, 60.0])),
      feature({ PRIM: "cnode", RCID: 11 }, point([22.02, 60.02]))
    ]);
    expect(edge?.geom.type === "line" && edge.geom.coords.length).toBe(2);
  });

  test("surveyed records are no position records; a node of a low-accuracy edge only places it", () => {
    const out = positions([
      feature({ PRIM: "edge", RCID: 1, QUAPOS: 1, NODE0: 10, NODE1: 11 }, null),
      feature({ PRIM: "edge", RCID: 2, QUAPOS: 10 }, null),
      feature({ PRIM: "cnode", RCID: 10, QUAPOS: null }, point([22.0, 60.0])),
      feature({ PRIM: "inode", RCID: 20, QUAPOS: 11 }, point([22.0, 60.0]))
    ]);
    expect(out).toEqual([]);
  });

  test("a node or isolated node of its own low accuracy, or a stated POSACC, is a point record", () => {
    const out = positions([
      feature({ PRIM: "inode", RCID: 20, QUAPOS: 8 }, point([22.0, 60.0])),
      feature({ PRIM: "cnode", RCID: 21, POSACC: 30 }, point([22.0, 60.0]))
    ]);
    expect(out.map((p) => [p.lowAccuracy, p.posacc])).toEqual([
      [true, undefined],
      [false, 30]
    ]);
    expect(out.every((p) => p.geom.type === "point" && !("topoSigma" in p))).toBe(true);
  });
});
