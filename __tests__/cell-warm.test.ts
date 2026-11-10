import fs from "fs";
import os from "os";
import path from "path";
import type { Warming, WarmReply } from "../src/cell-warm";
import { boxWarmer, startWarming, warmCells } from "../src/cell-warm";
import { cellSources, sourceKeys } from "../src/index-loader";
import type { EncReader } from "../src/ingest/enc-read-process";
import { readInProcess } from "../src/ingest/enc-read-process";
import type { Bbox } from "../src/ingest/wfs";
import { boxAround } from "../src/ingest/wfs";
import { growBbox } from "../src/spatial/build-box";
import { runBuild } from "../src/spatial/build-worker";
import { CELLS, ROCK } from "./helpers/fixture-index";

/**
 * The cell cache filled between chart box builds: the cells the next box can reach are read
 * into it, so the build that moves the box over them reads none through gdal3.js.
 */

const LIB_WARM = path.resolve(__dirname, "..", "lib", "cell-warm.js");

let tmp: string;
let cells: string;
let cacheDir: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-cell-warm-")));
  cells = path.join(tmp, "cells");
  cacheDir = path.join(tmp, "cache");
  fs.cpSync(CELLS, cells, { recursive: true, preserveTimestamps: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** readInProcess, recording the cells it reads. */
function counting(): { reader: EncReader; read: string[] } {
  const read: string[] = [];
  const reader: EncReader = (files, onRead) => {
    read.push(...files.map((f) => path.basename(f)));
    return readInProcess(files, onRead);
  };
  return { reader, read };
}

const BOX = boxAround(ROCK, 2);

test("a warmed cache leaves the box build no cell to read, and is warmed once", async () => {
  const job = { cellsDir: cells, cacheDir, around: growBbox(BOX, 4), hold: BOX };
  expect(await warmCells(job)).toBe(2);
  expect(await warmCells(job)).toBe(0);
  const build = counting();
  const dirs = cellSources(cells);
  const r = await runBuild(
    {
      dirs,
      leafZoom: 16,
      indexDir: path.join(tmp, "index"),
      threads: 1,
      cacheDir,
      box: { bbox: BOX, sources: sourceKeys(dirs) }
    },
    build.reader
  );
  fs.rmSync(r.staging, { recursive: true, force: true });
  expect(build.read).toEqual([]);
}, 30_000);

test("cells beyond the box's reach are not read", async () => {
  const far = boxAround([25, 65], 2);
  expect(await warmCells({ cellsDir: cells, cacheDir, around: far, hold: far })).toBe(0);
});

describe("one warming at a time, never beside a build", () => {
  function fake() {
    const events: string[] = [];
    let n = 0;
    const start = (around: Bbox, hold: Bbox): Warming => {
      const id = ++n;
      events.push(`start ${id} ${around[0] < hold[0] ? "grown" : "same"}`);
      return {
        stop: () => {
          events.push(`stop ${id}`);
          return Promise.resolve();
        }
      };
    };
    return { events, start };
  }

  test("a new box ends the run before; a build ends it; after stop none starts", async () => {
    const f = fake();
    const errors: string[] = [];
    const w = boxWarmer(f.start, (m) => errors.push(m));
    w.boxInUse(BOX, 18);
    w.boxInUse(BOX, 18);
    await w.beforeBuild();
    await w.beforeBuild();
    w.boxInUse(BOX, 18);
    w.stop();
    w.boxInUse(BOX, 18);
    expect(f.events).toEqual([
      "start 1 grown",
      "stop 1",
      "start 2 grown",
      "stop 2",
      "start 3 grown",
      "stop 3"
    ]);
    expect(errors).toEqual([]);
  });

  test("a run that cannot start is reported, and the next box tries again", () => {
    const errors: string[] = [];
    let fail = true;
    const w = boxWarmer(
      () => {
        if (fail) {
          throw new Error("EAGAIN");
        }
        return { stop: () => Promise.resolve() };
      },
      (m) => errors.push(m)
    );
    w.boxInUse(BOX, 18);
    fail = false;
    w.boxInUse(BOX, 18);
    expect(errors).toEqual(["filling the cell cache failed: EAGAIN"]);
  });
});

describe("in a child process", () => {
  beforeAll(() => {
    if (!fs.existsSync(LIB_WARM)) {
      throw new Error("lib/ is not built: run `npm run build` before the tests");
    }
  });

  test("reads the cells into the cache and says how many", async () => {
    const reply = await new Promise<WarmReply>((resolve) =>
      startWarming({ cellsDir: cells, cacheDir, around: BOX, hold: BOX }, 256, resolve, LIB_WARM)
    );
    expect(reply).toEqual({ read: 2 });
    expect(await warmCells({ cellsDir: cells, cacheDir, around: BOX, hold: BOX })).toBe(0);
  }, 30_000);

  test("stopped, it exits without a word", async () => {
    const replies: WarmReply[] = [];
    const run = startWarming(
      { cellsDir: cells, cacheDir, around: BOX, hold: BOX },
      256,
      (r) => replies.push(r),
      LIB_WARM
    );
    await run.stop();
    expect(replies).toEqual([]);
  }, 30_000);
});
