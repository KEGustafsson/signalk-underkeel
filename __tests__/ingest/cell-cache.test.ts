import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { cellSources, sourceKeys } from "../../src/index-loader";
import type { CacheLimits } from "../../src/ingest/cell-cache";
import { LayerCache } from "../../src/ingest/cell-cache";
import * as bounds from "../../src/ingest/enc-bounds";
import type { EncReader } from "../../src/ingest/enc-read-process";
import { readInProcess } from "../../src/ingest/enc-read-process";
import type { EncLayers } from "../../src/ingest/enc-wasm";
import { boxAround } from "../../src/ingest/wfs";
import { boxCells } from "../../src/spatial/build-box";
import type { BuildJob } from "../../src/spatial/build-worker";
import { runBuild } from "../../src/spatial/build-worker";
import { CELLS, ROCK } from "../helpers/fixture-index";

/**
 * The cell cache keeps each S-57 cell's read layers and extent between builds. A build from
 * it is the build from the cells byte for byte, and a cell whose files changed, or whose
 * entry is damaged, is read from the cell again (invariant 3).
 */

const RAW = path.resolve(__dirname, "..", "..", "fixtures", "s57", "FI5RAW01.000");

let tmp: string;
let cells: string;
let cacheDir: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-cell-cache-")));
  cells = path.join(tmp, "cells");
  cacheDir = path.join(tmp, "cache");
  fs.cpSync(CELLS, cells, { recursive: true, preserveTimestamps: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** readInProcess, recording the cells it reads. */
function counting(): { reader: EncReader; read: string[] } {
  const read: string[] = [];
  const reader: EncReader = (files) => {
    read.push(...files.map((f) => path.basename(f)));
    return readInProcess(files);
  };
  return { reader, read };
}

function job(cache = true): BuildJob {
  const dirs = cellSources(cells);
  return {
    dirs,
    leafZoom: 16,
    indexDir: path.join(tmp, "index"),
    threads: 1,
    box: { bbox: boxAround(ROCK, 2), sources: sourceKeys(dirs) },
    ...(cache ? { cacheDir } : {})
  };
}

/** The staged index files' bytes, base64, by name. */
async function staged(j: BuildJob, reader: EncReader): Promise<Record<string, string>> {
  const r = await runBuild(j, reader);
  const files = fs.readdirSync(r.staging).sort();
  const out = Object.fromEntries(
    files.map((f) => [f, fs.readFileSync(path.join(r.staging, f)).toString("base64")])
  );
  fs.rmSync(r.staging, { recursive: true, force: true });
  return out;
}

const entries = (): string[] => fs.readdirSync(cacheDir).filter((f) => f.endsWith(".layers"));

describe("index built from the cell cache", () => {
  test("cold, warm and without the cache, the staged files are the same bytes", async () => {
    const plain = await staged(job(false), readInProcess);
    const cold = counting();
    expect(await staged(job(), cold.reader)).toEqual(plain);
    expect(cold.read.sort()).toEqual(["FI4SYNTH.000", "FI5SYNTH.000"]);
    expect(entries()).toHaveLength(2);
    const warm = counting();
    expect(await staged(job(), warm.reader)).toEqual(plain);
    // Every cell kept: gdal3.js is not asked for any.
    expect(warm.read).toEqual([]);
    expect(Object.keys(plain)).toEqual([
      "box.json",
      "cells.json",
      "hazards.bin",
      "pyramid.bin",
      "reach.json"
    ]);
  }, 30_000);

  test("a new update, a touched file or a new edition reads that cell again", async () => {
    await staged(job(), readInProcess);
    const fi5 = path.join(cells, "FI5SYNTH.000");
    const fi4 = path.join(cells, "FI4SYNTH.000");
    const changes: [string, () => void][] = [
      ["FI5SYNTH.000", () => fs.writeFileSync(path.join(cells, "FI5SYNTH.001"), "update")],
      ["FI4SYNTH.000", () => fs.utimesSync(fi4, new Date(), new Date(Date.now() + 10_000))],
      // Another cell's bytes under this name: read as what is there now, never as before.
      ["FI5SYNTH.000", () => fs.copyFileSync(RAW, fi5)]
    ];
    const read: string[][] = [];
    for (const [, change] of changes) {
      change();
      const warm = counting();
      const built = await staged(job(), warm.reader);
      read.push(warm.read);
      expect(built).toEqual(await staged(job(false), readInProcess));
    }
    expect(read).toEqual(changes.map(([cell]) => [cell]));
  }, 30_000);

  test("a damaged or torn entry is read from the cell again, then rewritten", async () => {
    const plain = await staged(job(false), readInProcess);
    await staged(job(), readInProcess);
    const [a, b] = entries().map((e) => path.join(cacheDir, e)) as [string, string];
    const bytes = fs.readFileSync(a);
    const mid = bytes.length >> 1;
    bytes[mid] = (bytes[mid] as number) ^ 0xff;
    fs.writeFileSync(a, bytes);
    fs.truncateSync(b, fs.statSync(b).size - 7);
    const again = counting();
    expect(await staged(job(), again.reader)).toEqual(plain);
    expect(again.read).toHaveLength(2);
    const after = counting();
    await staged(job(), after.reader);
    expect(after.read).toEqual([]);
  }, 30_000);
});

describe("cache bounds", () => {
  let layers: Map<string, EncLayers>;
  let fi4: string;
  let fi5: string;
  beforeEach(async () => {
    [fi4, fi5] = cellSources(cells) as [string, string];
    layers = await readInProcess([fi4, fi5]);
  });

  async function write(present: string[], put: string[], limits: CacheLimits): Promise<void> {
    const cache = LayerCache.open(cacheDir, present, limits) as LayerCache;
    put.forEach((f) => cache.put(f, layers.get(f) as EncLayers));
    await cache.flush();
  }

  const unlimited: CacheLimits = { maxBytes: Infinity, minFreeBytes: 0 };

  test("past maxBytes the entries this build does not use go, those it uses stay", async () => {
    await write([fi4, fi5], [fi4], unlimited);
    const one = fs.statSync(path.join(cacheDir, entries()[0] as string)).size;
    const limits = { maxBytes: one * 1.5, minFreeBytes: 0 };
    // A later build of FI5 alone makes room by dropping FI4's entry.
    await write([fi4, fi5], [fi5], limits);
    expect(entries()).toEqual([expect.stringMatching(/^FI5SYNTH-/)]);
    // A build using both keeps the one it has and writes no other.
    await write([fi4, fi5], [fi5, fi4], limits);
    expect(entries()).toEqual([expect.stringMatching(/^FI5SYNTH-/)]);
  });

  test("entries of cells gone and writes of ended processes are removed when opened", async () => {
    await write([fi4, fi5], [fi4, fi5], unlimited);
    const ended = spawnSync(process.execPath, ["-e", "0"]).pid as number;
    const stray = path.join(cacheDir, `FI4SYNTH-0.layers.tmp-${ended}-0a1b2c3d`);
    fs.writeFileSync(stray, "torn");
    LayerCache.open(cacheDir, [fi5]);
    expect(entries()).toEqual([expect.stringMatching(/^FI5SYNTH-/)]);
    expect(fs.existsSync(stray)).toBe(false);
  });

  test("nothing is written that would leave less than minFreeBytes free", async () => {
    await write([fi4], [fi4], { maxBytes: Infinity, minFreeBytes: Number.MAX_SAFE_INTEGER });
    expect(entries()).toEqual([]);
  });
});

describe("cell extents kept for the box", () => {
  test("only a cell whose files changed is read again for its extent", () => {
    const dirs = cellSources(cells);
    const bbox = boxAround(ROCK, 2);
    const spy = jest.spyOn(bounds, "encBounds");
    try {
      const chosen = boxCells(dirs, bbox, cacheDir);
      expect(chosen).toEqual(boxCells(dirs, bbox));
      spy.mockClear();
      expect(boxCells(dirs, bbox, cacheDir)).toEqual(chosen);
      expect(spy).not.toHaveBeenCalled();
      const fi4 = dirs[0] as string;
      fs.utimesSync(fi4, new Date(), new Date(Date.now() + 10_000));
      expect(boxCells(dirs, bbox, cacheDir)).toEqual(chosen);
      expect(spy.mock.calls).toEqual([[fi4]]);
      // An extent changed on the disk no longer matches the file's sum: every cell is read again.
      const file = path.join(cacheDir, "extents.json");
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Record<string, { bbox: number[] }>;
      };
      (json.cells[fi4] as { bbox: number[] }).bbox[0] = 179;
      fs.writeFileSync(file, JSON.stringify(json));
      spy.mockClear();
      expect(boxCells(dirs, bbox, cacheDir)).toEqual(chosen);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
