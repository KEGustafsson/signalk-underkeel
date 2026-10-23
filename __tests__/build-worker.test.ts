import fs from "fs";
import os from "os";
import path from "path";
import type { BuildJob } from "../src/spatial/build-worker";
import { readCellDirectory } from "../src/ingest/cell-reader";
import { buildChartIndex, commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import type { IndexBuilder } from "../src/wfs-service";
import underkeel = require("../src/index");
import { CELLS, FIXTURES } from "./helpers/fixture-index";
import { fakeApp, fakeClock, T0 } from "./helpers/plugin-harness";
import { spreadCells } from "./helpers/shifted-cells";

/**
 * The off-loop index build behind the Traficom WFS box (plan §4.2, §6).
 * The worker entry runs in-process with a stubbed worker_threads; the real
 * thread needs the compiled lib/, which `npm run build` makes.
 */

const LIB_BUILDER = path.resolve(__dirname, "..", "lib", "wfs-service.js");
const LIB_WORKER = path.resolve(__dirname, "..", "lib", "spatial", "build-worker.js");
const LIB_STORE = path.resolve(__dirname, "..", "lib", "spatial", "store.js");
const built = fs.existsSync(LIB_BUILDER) && fs.existsSync(LIB_WORKER);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-worker-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function job(dirs = [path.join(FIXTURES, "FI5SYNTH")]): BuildJob {
  return { dirs, leafZoom: 16, indexDir: path.join(dir, "index") };
}

/** Runs the worker entry in-process and resolves with what it posted once it has. */
async function runWorkerEntry(data: BuildJob): Promise<unknown[]> {
  const messages: unknown[] = [];
  jest.isolateModules(() => {
    jest.doMock("worker_threads", () => ({
      parentPort: { postMessage: (m: unknown) => messages.push(m) },
      workerData: { ...data, threads: 1 }
    }));
    require("../src/spatial/build-worker");
  });
  jest.dontMock("worker_threads");
  for (let i = 0; i < 100 && messages.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return messages;
}

describe("index build worker entry", () => {
  test("builds and stages the index, leaving the index directory to the main thread", async () => {
    const j = job();
    const messages = await runWorkerEntry(j);
    expect(messages).toEqual([
      {
        ok: true,
        staging: expect.any(String),
        index: expect.objectContaining({
          minZoom: 10,
          leafZoom: 16,
          roots: { built: 1, copied: 0 }
        })
      }
    ]);
    expect(fs.existsSync(j.indexDir)).toBe(false);
    commitChartIndex(j.indexDir, (messages[0] as { staging: string }).staging);
    expect(loadChartIndex(j.indexDir).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
  });

  test("reports a failed build as a message instead of throwing", async () => {
    const messages = await runWorkerEntry(job([path.join(dir, "missing")]));
    expect(messages).toEqual([{ ok: false, error: expect.any(String) }]);
  });
});

describe("workerBuilder (compiled lib/)", () => {
  if (!built) {
    throw new Error("lib/ is not built: run `npm run build` before the tests");
  }

  async function builder(): Promise<IndexBuilder> {
    return ((await import(LIB_BUILDER)) as { workerBuilder: IndexBuilder }).workerBuilder;
  }

  test("indexes the cells in a worker thread and loads the result", async () => {
    const j = job();
    const index = await (await builder())(j, new AbortController().signal);
    expect(index.catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
    expect(fs.existsSync(path.join(j.indexDir, "pyramid.bin"))).toBe(true);
  });

  test("hands the index over from the worker without reading the saved files", async () => {
    const j = job();
    const read = jest.spyOn(fs, "readFileSync");
    try {
      const index = await (await builder())(j, new AbortController().signal);
      expect(read.mock.calls.filter(([f]) => String(f).startsWith(j.indexDir))).toEqual([]);
      const saved = loadChartIndex(j.indexDir);
      const { serializePyramid } = (await import(LIB_STORE)) as {
        serializePyramid: (s: unknown) => Buffer;
      };
      expect(serializePyramid(index.pyramid).equals(serializePyramid(saved.pyramid))).toBe(true);
      expect(index.hazards.features).toEqual(saved.hazards.features);
      expect(index.catalogue).toEqual(saved.catalogue);
    } finally {
      read.mockRestore();
    }
  });

  test("rejects with the worker's error when the build fails", async () => {
    const build = await builder();
    await expect(
      build(job([path.join(dir, "missing")]), new AbortController().signal)
    ).rejects.toThrow(/missing/);
  });

  test("rejects when aborted before the worker starts", async () => {
    const ctl = new AbortController();
    const pending = (await builder())(job(), ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  test("terminates a running worker on abort and leaves no index", async () => {
    const ctl = new AbortController();
    const j = job();
    const pending = (await builder())(j, ctl.signal);
    // One turn of the event loop lets the builder get past its wait and start the thread.
    await new Promise((resolve) => setImmediate(resolve));
    ctl.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("stop() during the build at start terminates the worker and leaves no index or staging", async () => {
    const build = await builder();
    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir);
    const plugin = underkeel(fakeApp(dataDir).app, fakeClock(T0), globalThis.fetch, build);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    plugin.stop();
    // A build with an aborted signal settles only once every aborted worker has exited.
    const done = new AbortController();
    done.abort();
    await expect(build(job(), done.signal)).rejects.toThrow("aborted");
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  test("S-57 cells read once by the build reach every region thread", async () => {
    const lib = (await import(LIB_WORKER)) as {
      runBuild: (j: BuildJob) => Promise<{ staging: string }>;
    };
    const s57 = path.resolve(__dirname, "..", "fixtures", "s57", "FI5RAW01.000");
    const dirs = [s57, path.join(FIXTURES, "FI5SYNTH")];
    const staged = (threads: number) =>
      lib.runBuild({ dirs, leafZoom: 16, indexDir: path.join(dir, `s57-${threads}`), threads });
    const [one, three] = (await Promise.all([staged(1), staged(3)])).map((r) => r.staging) as [
      string,
      string
    ];
    for (const file of ["pyramid.bin", "hazards.json", "cells.json", "reach.json"]) {
      expect(
        fs.readFileSync(path.join(three, file)).equals(fs.readFileSync(path.join(one, file)))
      ).toBe(true);
    }
    const cells = JSON.parse(fs.readFileSync(path.join(one, "cells.json"), "utf8")) as {
      cells: { name: string }[];
    };
    expect(cells.cells.map((c) => c.name)).toEqual(["FI5RAW01", "FI5SYNTH"]);
  });

  test("columns built on several threads join into the single-thread index, byte for byte", async () => {
    const lib = (await import(LIB_WORKER)) as {
      runBuild: (j: BuildJob) => Promise<{ staging: string }>;
    };
    const cells = spreadCells(path.join(dir, "cells"));
    const staged = (threads: number) =>
      lib.runBuild({
        dirs: cells,
        leafZoom: 16,
        indexDir: path.join(dir, `index-${threads}`),
        threads
      });
    const [one, three] = (await Promise.all([staged(1), staged(3)])).map((r) => r.staging) as [
      string,
      string
    ];
    for (const file of ["pyramid.bin", "hazards.json", "cells.json", "reach.json"]) {
      expect(
        fs.readFileSync(path.join(three, file)).equals(fs.readFileSync(path.join(one, file)))
      ).toBe(true);
    }
    const { serializePyramid } = (await import(LIB_STORE)) as {
      serializePyramid: (s: unknown) => Buffer;
    };
    const whole = buildChartIndex(
      cells.map((d, i) => readCellDirectory(d, i)),
      { leafZoom: 16 }
    );
    expect(
      fs.readFileSync(path.join(one, "pyramid.bin")).equals(serializePyramid(whole.pyramid))
    ).toBe(true);
  });
});
