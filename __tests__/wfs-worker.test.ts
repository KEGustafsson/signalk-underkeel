import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { runBuild } from "../src/spatial/build-worker";
import { loadChartIndex, saveChartIndex, stageChartIndex } from "../src/spatial/chart-index";
import { Worker } from "worker_threads";
import { workerBuilder, workerHeapLimitMb } from "../src/wfs-service";
import { FIXTURES, fixtureIndex } from "./helpers/fixture-index";

/** A worker thread that exits only when the test lets it. */
class MockWorker extends EventEmitter {
  exit: () => void = () => undefined;
  readonly exited = new Promise<number>((resolve) => {
    this.exit = () => resolve(1);
  });
  terminate(): Promise<number> {
    return this.exited;
  }
}

const mockWorkers: MockWorker[] = [];

jest.mock("worker_threads", () => ({
  Worker: jest.fn(() => {
    const w = new MockWorker();
    mockWorkers.push(w);
    return w;
  })
}));

const job = { dirs: [], leafZoom: 18, indexDir: "/tmp/index" };
const settle = () => new Promise((r) => setImmediate(r));

test("a build after an abort waits for the aborted worker to exit, and the aborted one never resolves", async () => {
  const first = new AbortController();
  const aborted = workerBuilder(job, first.signal);
  await settle();
  expect(mockWorkers).toHaveLength(1);
  first.abort();
  void workerBuilder(job, new AbortController().signal);
  await settle();
  expect(mockWorkers).toHaveLength(1);
  mockWorkers[0]?.emit("message", { ok: true });
  mockWorkers[0]?.exit();
  await expect(aborted).rejects.toThrow("aborted");
  await settle();
  expect(mockWorkers).toHaveLength(2);
});

test("the worker runs under a heap limit, and running out of it fails the build with the limit", async () => {
  mockWorkers.length = 0;
  const built = workerBuilder(job, new AbortController().signal);
  await settle();
  const options = (Worker as unknown as jest.Mock).mock.calls.at(-1)?.[1] as {
    resourceLimits: { maxOldGenerationSizeMb: number };
  };
  expect(options.resourceLimits.maxOldGenerationSizeMb).toBe(workerHeapLimitMb());
  mockWorkers[0]?.emit(
    "error",
    Object.assign(
      new Error("Worker terminated due to reaching memory limit: JS heap out of memory"),
      {
        code: "ERR_WORKER_OUT_OF_MEMORY"
      }
    )
  );
  await expect(built).rejects.toThrow(
    `index build stopped at the ${workerHeapLimitMb()} MB worker heap limit`
  );
});

describe("only the main thread writes the index directory", () => {
  let tmp: string;
  let indexDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-worker-"));
    indexDir = path.join(tmp, "index");
    mockWorkers.length = 0;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("the build worker stages the index and leaves the index directory alone", async () => {
    const staging = await runBuild({
      dirs: [path.join(FIXTURES, "FI5SYNTH")],
      leafZoom: 14,
      indexDir,
      threads: 1
    });
    expect(fs.existsSync(indexDir)).toBe(false);
    expect(loadChartIndex(staging).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
  });

  test("a finished build is moved into the index directory and loaded", async () => {
    const built = workerBuilder({ ...job, indexDir }, new AbortController().signal);
    await settle();
    const staging = stageChartIndex(indexDir, fixtureIndex());
    mockWorkers[0]?.emit("message", { ok: true, staging });
    const index = await built;
    expect(index.catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH", "FI4SYNTH"]);
    expect(fs.existsSync(staging)).toBe(false);
  });

  test("an aborted worker that finishes late never replaces the index saved since", async () => {
    const first = new AbortController();
    const aborted = workerBuilder({ ...job, indexDir }, first.signal);
    await settle();
    first.abort();
    // The next start() saves its own index while the aborted worker is still exiting.
    saveChartIndex(indexDir, fixtureIndex());
    const before = fs.readFileSync(path.join(indexDir, "pyramid.bin"));
    const late = stageChartIndex(indexDir, {
      ...fixtureIndex(),
      catalogue: { version: 1, cells: [] }
    });
    mockWorkers[0]?.emit("message", { ok: true, staging: late });
    mockWorkers[0]?.exit();
    await expect(aborted).rejects.toThrow("aborted");
    expect(fs.readFileSync(path.join(indexDir, "pyramid.bin"))).toEqual(before);
    expect(loadChartIndex(indexDir).catalogue.cells).toHaveLength(2);
    expect(fs.existsSync(late)).toBe(false);
  });
});
