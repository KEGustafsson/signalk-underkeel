import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import { cellDirectories, loadOrBuildIndex } from "../src/index-loader";

const FIXTURES = path.resolve(__dirname, "..", "fixtures", "enc");

let tmp: string;
let cellsDir: string;
let dataDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-loader-"));
  cellsDir = path.join(tmp, "cells");
  dataDir = path.join(tmp, "data");
  fs.mkdirSync(cellsDir);
  fs.mkdirSync(dataDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const copyCell = (name: string): void =>
  fs.cpSync(path.join(FIXTURES, name), path.join(cellsDir, name), { recursive: true });

const names = (r: ReturnType<typeof loadOrBuildIndex>): string[] =>
  r.index?.catalogue.cells.map((c) => c.name) ?? [];

const load = (extra: Record<string, unknown> = {}) =>
  loadOrBuildIndex(parseConfig({ cellsDir, leafZoom: 16, ...extra }), dataDir);

describe("cell directories", () => {
  test("a symlink to a cell directory is indexed like the directory itself", () => {
    fs.symlinkSync(path.join(FIXTURES, "FI4SYNTH"), path.join(cellsDir, "FI4SYNTH"), "dir");
    copyCell("FI5SYNTH");
    expect(cellDirectories(cellsDir).map((d) => path.basename(d))).toEqual([
      "FI4SYNTH",
      "FI5SYNTH"
    ]);
    const r = load();
    expect(names(r)).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    expect(r.reason).toBeUndefined();
  });

  test("entries that look like cells but are not directories are reported", () => {
    copyCell("FI5SYNTH");
    fs.writeFileSync(path.join(cellsDir, "FI4ABCDE.000"), "");
    fs.symlinkSync(path.join(tmp, "gone"), path.join(cellsDir, "FI4GONE"));
    fs.writeFileSync(path.join(cellsDir, "README.txt"), "");
    fs.writeFileSync(path.join(cellsDir, ".DS_Store"), "");
    const r = load();
    expect(names(r)).toEqual(["FI5SYNTH"]);
    expect(r.reason).toMatch(/FI4ABCDE\.000/);
    expect(r.reason).toMatch(/FI4GONE/);
    expect(r.reason).not.toMatch(/README|DS_Store/);
    // A saved index loaded on the next start repeats the warning.
    const again = load();
    expect(again.built).toBe(false);
    expect(again.reason).toMatch(/FI4ABCDE\.000/);
  });

  test("a missing cells directory keeps the saved index and says so", () => {
    copyCell("FI4SYNTH");
    load();
    fs.rmSync(cellsDir, { recursive: true });
    const r = load();
    expect(names(r)).toEqual(["FI4SYNTH"]);
    expect(r.built).toBe(false);
    expect(r.reason).toMatch(/not found.*saved index/);
  });
});

describe("saved index against the cells directory", () => {
  test("an unchanged cells directory loads the saved index without a reason", () => {
    copyCell("FI4SYNTH");
    expect(load().built).toBe(true);
    const again = load();
    expect(again.built).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  test("a cell added after the index was saved rebuilds it and says why", () => {
    copyCell("FI4SYNTH");
    expect(names(load())).toEqual(["FI4SYNTH"]);
    copyCell("FI5SYNTH");
    const r = load();
    expect(r.built).toBe(true);
    expect(names(r)).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    expect(r.reason).toMatch(/rebuilt.*added FI5SYNTH/);
  });

  test("a removed cell rebuilds the index without it", () => {
    copyCell("FI4SYNTH");
    copyCell("FI5SYNTH");
    load();
    fs.rmSync(path.join(cellsDir, "FI5SYNTH"), { recursive: true });
    const r = load();
    expect(r.built).toBe(true);
    expect(names(r)).toEqual(["FI4SYNTH"]);
    expect(r.reason).toMatch(/removed FI5SYNTH/);
  });

  test("a new edition or update of a cell rebuilds the index", () => {
    copyCell("FI5SYNTH");
    expect(load().index?.catalogue.cells[0]?.update).toBe(1);
    const dsid = path.join(cellsDir, "FI5SYNTH", "DSID.geojson");
    fs.writeFileSync(
      dsid,
      fs.readFileSync(dsid, "utf8").replace('"DSID_UPDN": "1"', '"DSID_UPDN": "2"')
    );
    const r = load();
    expect(r.built).toBe(true);
    expect(r.index?.catalogue.cells[0]?.update).toBe(2);
    expect(r.reason).toMatch(/FI5SYNTH edition 3 update 2/);
  });

  test("datum areas exported after the index was saved rebuild it", () => {
    copyCell("FI5SYNTH");
    load();
    const area = { type: "Feature", geometry: null, properties: { VERDAT: 24 } };
    fs.writeFileSync(
      path.join(cellsDir, "FI5SYNTH", "M_SDAT.geojson"),
      JSON.stringify({ type: "FeatureCollection", features: [area] })
    );
    const r = load();
    expect(r.built).toBe(true);
    expect(r.index?.catalogue.cells[0]?.datumAreas).toEqual([24]);
    expect(r.reason).toMatch(/FI5SYNTH edition 3 update 1 datum areas 24/);
  });

  test("Rebuild index at start still rebuilds an unchanged directory", () => {
    copyCell("FI4SYNTH");
    load();
    const r = load({ rebuildIndex: true });
    expect(r.built).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

describe("a saved index that cannot be read", () => {
  const indexFile = (name: string): string => path.join(dataDir, "index", name);
  const halve = (name: string): void =>
    fs.truncateSync(indexFile(name), Math.floor(fs.statSync(indexFile(name)).size / 2));

  test.each([
    ["an empty cells.json", () => fs.truncateSync(indexFile("cells.json"), 0)],
    ["a half-written pyramid.bin", () => halve("pyramid.bin")],
    ["a half-written hazards.json", () => halve("hazards.json")],
    [
      "an empty cells.json and pyramid.bin",
      () => ["cells.json", "pyramid.bin"].forEach((f) => fs.truncateSync(indexFile(f), 0))
    ]
  ])("%s is rebuilt from the cells, naming the read error", (_what, tear) => {
    copyCell("FI4SYNTH");
    load();
    tear();
    const r = load();
    expect(r.built).toBe(true);
    expect(names(r)).toEqual(["FI4SYNTH"]);
    expect(r.reason).toMatch(/rebuilt the index: the saved one could not be read \(.+\)/);
    // The next start loads the rebuilt index again.
    const again = load();
    expect(again.built).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  test("without cells to rebuild from, the read error is the reason", () => {
    copyCell("FI4SYNTH");
    load();
    halve("pyramid.bin");
    const r = loadOrBuildIndex(parseConfig({ leafZoom: 16 }), dataDir);
    expect(r.index).toBeUndefined();
    expect(r.reason).toMatch(/chart index failed: .*truncated/);
  });
});
