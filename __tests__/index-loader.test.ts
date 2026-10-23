import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import {
  BOX_WAITING_REASON,
  cellSources,
  loadOrBuildIndex,
  planIndex,
  sourceKeys
} from "../src/index-loader";
import * as encWasm from "../src/ingest/enc-wasm";
import { boxAround } from "../src/ingest/wfs";
import { BOX_FILE, readBox } from "../src/spatial/build-box";
import { runBuild } from "../src/spatial/build-worker";
import { commitChartIndex, loadChartIndex, loadChartIndexAsync } from "../src/spatial/chart-index";
import { gunzipSync } from "zlib";
import { ROCK } from "./helpers/fixture-index";

/** The synthetic scenario as S-57 cells (fixtures/s57/generate.js). */
const CELLS = path.resolve(__dirname, "..", "fixtures", "s57", "synth");

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

/** `<dir>/<name>/<name>.000`, as in an exchange set; `dir` defaults to the cells directory. */
const copyCell = (name: string, dir = cellsDir): string => {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(path.join(CELLS, `${name}.000`), path.join(folder, `${name}.000`));
  return folder;
};

const names = (r: Awaited<ReturnType<typeof loadOrBuildIndex>>): string[] =>
  r.index?.catalogue.cells.map((c) => c.name) ?? [];

const load = (extra: Record<string, unknown> = {}) =>
  loadOrBuildIndex(parseConfig({ cellsDir, boxRadiusKm: 0, leafZoom: 16, ...extra }), dataDir);

// A junction on Windows, which needs no symlink privilege; the type is ignored elsewhere.
const linkDir = (target: string, link: string) => fs.symlinkSync(target, link, "junction");

describe("cell directories", () => {
  test("a symlink to a cell's folder is indexed like the folder itself", async () => {
    linkDir(copyCell("FI4SYNTH", path.join(tmp, "elsewhere")), path.join(cellsDir, "FI4SYNTH"));
    copyCell("FI5SYNTH");
    expect(cellSources(cellsDir).map((d) => path.basename(d))).toEqual([
      "FI4SYNTH.000",
      "FI5SYNTH.000"
    ]);
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

  test("a cell file replaced by a new edition or update rebuilds the index", async () => {
    const folder = copyCell("FI5SYNTH");
    expect((await load()).index?.catalogue.cells[0]).toMatchObject({ edition: 3, update: 1 });
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(folder, "FI5SYNTH.000"), t, t);
    const r = await load();
    expect(r.built).toBe(true);
    expect(r.reason).toMatch(/rebuilt the index: cells in .* changed .*added FI5SYNTH files/);
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
    const p = planIndex(parseConfig({ cellsDir, boxRadiusKm: 0, leafZoom: 16 }), dataDir, [], 0);
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
    const p = planIndex(parseConfig({ cellsDir, boxRadiusKm: 0, leafZoom: 16 }), dataDir, [], 0);
    if (!("read" in p)) {
      throw new Error("expected a read plan");
    }
    const err = await loadChartIndexAsync(p.read).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(p.unreadable(err)).toMatchObject({
      build: { dirs: [path.join(cellsDir, "FI4SYNTH", "FI4SYNTH.000")] },
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

describe("a saved index built in a box around the vessel", () => {
  const indexDir = (): string => path.join(dataDir, "index");
  const BOX = boxAround(ROCK, 1);
  const config = (extra: Record<string, unknown> = {}) =>
    parseConfig({ cellsDir, leafZoom: 16, ...extra });
  /** Builds and commits the cells around ROCK, as the box service does. */
  const saveBoxIndex = async (): Promise<void> => {
    const dirs = cellSources(cellsDir);
    const job = { dirs, leafZoom: 16, indexDir: indexDir(), threads: 1 };
    const r = await runBuild({ ...job, box: { bbox: BOX, sources: sourceKeys(dirs) } });
    commitChartIndex(indexDir(), r.staging);
  };

  beforeEach(async () => {
    copyCell("FI4SYNTH");
    copyCell("FI5SYNTH");
    await saveBoxIndex();
  });

  test("with boxRadiusKm 0 is rebuilt from every cell, not loaded as if whole", () => {
    const p = planIndex(config({ boxRadiusKm: 0 }), dataDir);
    expect(p).toMatchObject({
      build: { dirs: cellSources(cellsDir) },
      notes: ["rebuilt the index: the saved one was built in a box around the vessel"]
    });
    expect("build" in p && p.build.box).toBeUndefined();
  });

  test.each([
    ["an empty cells.json", () => fs.truncateSync(path.join(indexDir(), "cells.json"), 0)],
    ["an empty hazards.json", () => fs.truncateSync(path.join(indexDir(), "hazards.json"), 0)]
  ])("with %s is rebuilt in its saved box, not from every cell", (_what, tear) => {
    tear();
    const p = planIndex(config(), dataDir);
    expect("build" in p && p.build.box).toEqual({
      bbox: BOX,
      sources: sourceKeys(cellSources(cellsDir))
    });
    expect("build" in p && p.notes).toEqual([
      expect.stringMatching(/^rebuilt the index: the saved one could not be read \(.+\)$/)
    ]);
  });

  test("read off the event loop and found unreadable, it is rebuilt in its saved box", () => {
    const p = planIndex(config(), dataDir, [], 0);
    if (!("read" in p)) {
      throw new Error("expected a read plan");
    }
    const next = p.unreadable(new Error("pyramid file is truncated"));
    expect("build" in next && next.build.box?.bbox).toEqual(BOX);
  });

  test("unreadable without its box file, nothing is built until the vessel's position", () => {
    fs.truncateSync(path.join(indexDir(), "cells.json"), 0);
    fs.rmSync(path.join(indexDir(), BOX_FILE));
    expect(planIndex(config(), dataDir)).toEqual({
      load: {
        indexDir: indexDir(),
        built: false,
        reason: expect.stringMatching(
          new RegExp(`^${BOX_WAITING_REASON}; not using the saved index: the saved one could not`)
        )
      }
    });
  });

  test("from an older pyramid version is rebuilt and says so, not that the zoom differs", () => {
    const file = path.join(indexDir(), "pyramid.bin");
    const buf = fs.readFileSync(file);
    const nl = buf.indexOf(0x0a);
    const header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as Record<string, unknown>;
    const old = Buffer.from(`${JSON.stringify({ ...header, version: 3 })}\n`, "utf8");
    fs.writeFileSync(file, Buffer.concat([old, buf.subarray(nl + 1)]));
    const p = planIndex(config(), dataDir);
    expect("build" in p && p.notes).toEqual([
      "rebuilt the index: the saved one is from an older pyramid version or its header is damaged"
    ]);
    expect(readBox(indexDir())?.leafZoom).toBe(16);
  });

  test("with its WFS cell left out of the start, torn or gone, it is loaded, not rebuilt", () => {
    const box = readBox(indexDir());
    const sources = [...(box?.sources ?? []), "FI1WFS01 edition 1 update 0"].sort();
    const file = path.join(indexDir(), BOX_FILE);
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...box, sources }));
    const p = planIndex(config({ wfs: { enabled: true } }), dataDir);
    expect("load" in p && p.load.index?.catalogue.cells).toHaveLength(2);
    // An ENC cell changed is still rebuilt in the box.
    fs.rmSync(path.join(cellsDir, "FI5SYNTH"), { recursive: true });
    expect(planIndex(config({ wfs: { enabled: true } }), dataDir)).toMatchObject({
      build: { box: { bbox: BOX } }
    });
  });

  test("each cell is stamped once at start", () => {
    const stamp = jest.spyOn(encWasm, "encStamp");
    try {
      const p = planIndex(config(), dataDir);
      expect("load" in p && p.load.index?.catalogue.cells).toHaveLength(2);
      expect(stamp).toHaveBeenCalledTimes(2);
    } finally {
      stamp.mockRestore();
    }
  });
});
