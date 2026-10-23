import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import { cellSources, loadOrBuildIndex, planIndex } from "../src/index-loader";
import { loadChartIndex, loadChartIndexAsync } from "../src/spatial/chart-index";
import { gunzipSync } from "zlib";

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

const names = (r: Awaited<ReturnType<typeof loadOrBuildIndex>>): string[] =>
  r.index?.catalogue.cells.map((c) => c.name) ?? [];

const load = (extra: Record<string, unknown> = {}) =>
  loadOrBuildIndex(parseConfig({ cellsDir, leafZoom: 16, ...extra }), dataDir);

// A junction on Windows, which needs no symlink privilege; the type is ignored elsewhere.
const linkDir = (target: string, link: string) => fs.symlinkSync(target, link, "junction");

describe("cell directories", () => {
  test("a symlink to a cell directory is indexed like the directory itself", async () => {
    linkDir(path.join(FIXTURES, "FI4SYNTH"), path.join(cellsDir, "FI4SYNTH"));
    copyCell("FI5SYNTH");
    expect(cellSources(cellsDir).map((d) => path.basename(d))).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    const r = await load();
    expect(names(r)).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    expect(r.reason).toBeUndefined();
  });

  test("a dangling link or a folder named like a cell without one is reported", async () => {
    copyCell("FI5SYNTH");
    linkDir(path.join(tmp, "gone"), path.join(cellsDir, "FI4GONE"));
    fs.mkdirSync(path.join(cellsDir, "FI4EMPTY"));
    fs.writeFileSync(path.join(cellsDir, "README.txt"), "");
    fs.writeFileSync(path.join(cellsDir, ".DS_Store"), "");
    const r = await load();
    expect(names(r)).toEqual(["FI5SYNTH"]);
    expect(r.reason).toMatch(/FI4GONE/);
    expect(r.reason).toMatch(/FI4EMPTY/);
    expect(r.reason).not.toMatch(/README|DS_Store/);
    // A saved index loaded on the next start repeats the warning.
    const again = await load();
    expect(again.built).toBe(false);
    expect(again.reason).toMatch(/FI4GONE/);
  });

  test("a .000 file GDAL cannot read fails the build, naming it", async () => {
    copyCell("FI5SYNTH");
    fs.writeFileSync(path.join(cellsDir, "FI4ABCDE.000"), "");
    const r = await load();
    expect(r.index).toBeUndefined();
    expect(r.reason).toMatch(/chart index failed: GDAL cannot read .*FI4ABCDE\.000/);
  });

  test("a missing cells directory keeps the saved index and says so", async () => {
    copyCell("FI4SYNTH");
    await load();
    fs.rmSync(cellsDir, { recursive: true });
    const r = await load();
    expect(names(r)).toEqual(["FI4SYNTH"]);
    expect(r.built).toBe(false);
    expect(r.reason).toMatch(/not found.*saved index/);
  });
});

describe("S-57 cells as delivered", () => {
  const S57 = path.resolve(__dirname, "..", "fixtures", "s57", "FI5RAW01.000");
  const encRoot = (): string => {
    const dir = path.join(cellsDir, "ENC_ROOT", "FI5RAW01");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(S57, path.join(dir, "FI5RAW01.000"));
    return dir;
  };

  test("are indexed from their .000 files, and the saved index is used while they stay", async () => {
    encRoot();
    copyCell("FI5SYNTH");
    const r = await load();
    expect(r.built).toBe(true);
    expect(names(r)).toEqual(["FI5RAW01", "FI5SYNTH"]);
    expect(r.index?.catalogue.cells[0]).toMatchObject({ edition: 1, files: expect.any(String) });
    const again = await load();
    expect(again.built).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  test("a changed cell file rebuilds the index; other files beside it do not", async () => {
    const dir = encRoot();
    await load();
    fs.copyFileSync(S57, path.join(dir, "FI5RAW01.000.bak"));
    expect((await load()).built).toBe(false);
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, "FI5RAW01.000"), t, t);
    const r = await load();
    expect(r.built).toBe(true);
    expect(r.reason).toMatch(/rebuilt the index: cells in .* changed/);
  });
});

describe("saved index against the cells directory", () => {
  test("an unchanged cells directory loads the saved index without a reason", async () => {
    copyCell("FI4SYNTH");
    expect((await load()).built).toBe(true);
    const again = await load();
    expect(again.built).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  test("a cell added after the index was saved rebuilds it and says why", async () => {
    copyCell("FI4SYNTH");
    expect(names(await load())).toEqual(["FI4SYNTH"]);
    copyCell("FI5SYNTH");
    const r = await load();
    expect(r.built).toBe(true);
    expect(names(r)).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    expect(r.reason).toMatch(/rebuilt.*added FI5SYNTH/);
  });

  test("a removed cell rebuilds the index without it", async () => {
    copyCell("FI4SYNTH");
    copyCell("FI5SYNTH");
    await load();
    fs.rmSync(path.join(cellsDir, "FI5SYNTH"), { recursive: true });
    const r = await load();
    expect(r.built).toBe(true);
    expect(names(r)).toEqual(["FI4SYNTH"]);
    expect(r.reason).toMatch(/removed FI5SYNTH/);
  });

  test("a new edition or update of a cell rebuilds the index", async () => {
    copyCell("FI5SYNTH");
    expect((await load()).index?.catalogue.cells[0]?.update).toBe(1);
    const dsid = path.join(cellsDir, "FI5SYNTH", "DSID.geojson");
    fs.writeFileSync(
      dsid,
      fs.readFileSync(dsid, "utf8").replace('"DSID_UPDN": "1"', '"DSID_UPDN": "2"')
    );
    const r = await load();
    expect(r.built).toBe(true);
    expect(r.index?.catalogue.cells[0]?.update).toBe(2);
    expect(r.reason).toMatch(/FI5SYNTH edition 3 update 2/);
  });

  test("datum areas exported after the index was saved rebuild it", async () => {
    copyCell("FI5SYNTH");
    await load();
    const area = { type: "Feature", geometry: null, properties: { VERDAT: 24 } };
    fs.writeFileSync(
      path.join(cellsDir, "FI5SYNTH", "M_SDAT.geojson"),
      JSON.stringify({ type: "FeatureCollection", features: [area] })
    );
    const r = await load();
    expect(r.built).toBe(true);
    expect(r.index?.catalogue.cells[0]?.datumAreas).toEqual([24]);
    expect(r.reason).toMatch(/FI5SYNTH edition 3 update 1 datum areas 24/);
  });

  test("Rebuild index at start still rebuilds an unchanged directory", async () => {
    copyCell("FI4SYNTH");
    await load();
    const r = await load({ rebuildIndex: true });
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
  ])("%s is rebuilt from the cells, naming the read error", async (_what, tear) => {
    copyCell("FI4SYNTH");
    await load();
    tear();
    const r = await load();
    expect(r.built).toBe(true);
    expect(names(r)).toEqual(["FI4SYNTH"]);
    expect(r.reason).toMatch(/rebuilt the index: the saved one could not be read \(.+\)/);
    // The next start loads the rebuilt index again.
    const again = await load();
    expect(again.built).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  test("without cells to rebuild from, the read error is the reason", async () => {
    copyCell("FI4SYNTH");
    await load();
    halve("pyramid.bin");
    const r = await loadOrBuildIndex(parseConfig({ leafZoom: 16 }), dataDir);
    expect(r.index).toBeUndefined();
    expect(r.reason).toMatch(/chart index failed: .*truncated/);
  });
});

test("an uncompressed version 3 pyramid.bin from an older plugin is rebuilt", async () => {
  copyCell("FI4SYNTH");
  await load();
  const file = path.join(dataDir, "index", "pyramid.bin");
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(0x0a);
  const header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as Record<string, unknown>;
  const v3 = Buffer.from(`${JSON.stringify({ ...header, version: 3 })}\n`, "utf8");
  fs.writeFileSync(file, Buffer.concat([v3, gunzipSync(buf.subarray(nl + 1))]));
  const r = await load();
  expect(r.built).toBe(true);
  expect(names(r)).toEqual(["FI4SYNTH"]);
  expect((await load()).built).toBe(false);
});

describe("a saved index too large to load on the event loop", () => {
  test("is planned as a read, and the read off the loop loads the same index", async () => {
    copyCell("FI4SYNTH");
    await load();
    const p = planIndex(parseConfig({ cellsDir, leafZoom: 16 }), dataDir, [], 0);
    expect(p).toMatchObject({ read: path.join(dataDir, "index"), notes: [] });
    if (!("read" in p)) {
      return;
    }
    const sync = loadChartIndex(p.read);
    const read = await loadChartIndexAsync(p.read);
    expect(read.catalogue).toEqual(sync.catalogue);
    expect(read.hazards.features).toEqual(sync.hazards.features);
    expect(read.pyramid.count).toBe(sync.pyramid.count);
    for (let z = sync.pyramid.minZoom; z <= sync.pyramid.leafZoom; z++) {
      for (const [x, y, i] of sync.pyramid.entries(z)) {
        expect(read.pyramid.values(read.pyramid.find(z, x, y))).toEqual(sync.pyramid.values(i));
      }
    }
  });

  test("falls back to a rebuild naming the read error, or without cells to the error", async () => {
    copyCell("FI4SYNTH");
    await load();
    const file = path.join(dataDir, "index", "pyramid.bin");
    fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
    const p = planIndex(parseConfig({ cellsDir, leafZoom: 16 }), dataDir, [], 0);
    if (!("read" in p)) {
      throw new Error("expected a read plan");
    }
    const err = await loadChartIndexAsync(p.read).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(p.unreadable(err)).toMatchObject({
      build: { dirs: [path.join(cellsDir, "FI4SYNTH")] },
      notes: [expect.stringMatching(/could not be read \(pyramid file is truncated\)/)]
    });
    const none = planIndex(parseConfig({ leafZoom: 16 }), dataDir, [], 0);
    expect("read" in none && none.unreadable(err)).toEqual({
      load: {
        indexDir: path.join(dataDir, "index"),
        built: false,
        reason: expect.stringMatching(/chart index failed: pyramid file is truncated/)
      }
    });
  });
});
