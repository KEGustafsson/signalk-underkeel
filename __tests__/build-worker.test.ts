import fs from "fs";
import os from "os";
import path from "path";
import type { BuildJob } from "../src/spatial/build-worker";
import { loadChartIndex } from "../src/spatial/chart-index";
import type { IndexBuilder } from "../src/wfs-service";
import { FIXTURES } from "./helpers/fixture-index";

/**
 * The off-loop index build behind the Traficom WFS box (plan §4.2, §6).
 * The worker entry runs in-process with a stubbed worker_threads; the real
 * thread needs the compiled lib/, which `npm run build` makes.
 */

const LIB_BUILDER = path.resolve(__dirname, "..", "lib", "wfs-service.js");
const LIB_WORKER = path.resolve(__dirname, "..", "lib", "spatial", "build-worker.js");
const built = fs.existsSync(LIB_BUILDER) && fs.existsSync(LIB_WORKER);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-worker-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function job(dirs = [path.join(FIXTURES, "FI5SYNTH")]): BuildJob {
  return { dirs, leafZoom: 16, indexDir: path.join(dir, "index") };
}

function runWorkerEntry(data: BuildJob): unknown[] {
  const messages: unknown[] = [];
  jest.isolateModules(() => {
    jest.doMock("worker_threads", () => ({
      parentPort: { postMessage: (m: unknown) => messages.push(m) },
      workerData: data
    }));
    require("../src/spatial/build-worker");
  });
  jest.dontMock("worker_threads");
  return messages;
}

describe("index build worker entry", () => {
  test("builds and saves the index, then reports ok", () => {
    const j = job();
    expect(runWorkerEntry(j)).toEqual([{ ok: true }]);
    expect(loadChartIndex(j.indexDir).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
  });

  test("reports a failed build as a message instead of throwing", () => {
    const messages = runWorkerEntry(job([path.join(dir, "missing")]));
    expect(messages).toEqual([{ ok: false, error: expect.any(String) }]);
  });
});

describe("workerBuilder (compiled lib/)", () => {
  const maybe = built ? test : test.skip;
  if (!built) {
    console.warn("lib/ is not built: run `npm run build` to test the worker thread");
  }

  async function builder(): Promise<IndexBuilder> {
    return ((await import(LIB_BUILDER)) as { workerBuilder: IndexBuilder }).workerBuilder;
  }

  maybe("indexes the cells in a worker thread and loads the result", async () => {
    const j = job();
    const index = await (await builder())(j, new AbortController().signal);
    expect(index.catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
    expect(fs.existsSync(path.join(j.indexDir, "pyramid.bin"))).toBe(true);
  });

  maybe("rejects with the worker's error when the build fails", async () => {
    const build = await builder();
    await expect(
      build(job([path.join(dir, "missing")]), new AbortController().signal)
    ).rejects.toThrow(/./);
  });

  maybe("rejects when aborted", async () => {
    const ctl = new AbortController();
    const pending = (await builder())(job(), ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});
