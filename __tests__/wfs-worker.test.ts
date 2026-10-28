import { EventEmitter } from "events";
import { fork } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { IndexParts } from "../src/spatial/build-worker";
import { runBuild } from "../src/spatial/build-worker";
import { loadChartIndex, saveChartIndex, stageChartIndex } from "../src/spatial/chart-index";
import { serializeHazards } from "../src/spatial/hazard-file";
import { pyramidColumns } from "../src/spatial/store";
import { workerBuilder, workerHeapLimitMb } from "../src/wfs-service";
import underkeel = require("../src/index");
import { CELLS, FIXTURES, fixtureIndex, ROCK } from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "./helpers/plugin-harness";

/** Process ids no system hands out (pid_max is at most 2^22), so no real process is signalled. */
const FAKE_PID = 5_000_000;

/** A build process that replies and exits only when the test lets it. */
class MockChild extends EventEmitter {
  readonly pid = FAKE_PID + mockChildren.length;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  readonly sent: unknown[] = [];
  readonly kills: string[] = [];
  send(m: unknown, done?: (err: Error | null) => void): boolean {
    this.sent.push(m);
    done?.(null);
    return true;
  }
  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }
  close(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

const mockChildren: MockChild[] = [];

jest.mock("child_process", () => ({
  fork: jest.fn(() => {
    const c = new MockChild();
    mockChildren.push(c);
    return c;
  })
}));

const signalled: [number, string | number | undefined][] = [];
const realKill = process.kill.bind(process);
beforeEach(() => {
  mockChildren.length = 0;
  signalled.length = 0;
  jest.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (Math.abs(pid) < FAKE_PID) {
      return realKill(pid, signal);
    }
    signalled.push([pid, signal]);
    return true;
  });
});
afterEach(() => jest.restoreAllMocks());

const job = { dirs: [], leafZoom: 18, indexDir: "/tmp/index" };
const settle = () => new Promise((r) => setImmediate(r));

test("a build after an abort waits for the aborted process to exit, and the aborted one never resolves", async () => {
  const first = new AbortController();
  const aborted = workerBuilder(job, first.signal);
  await settle();
  expect(mockChildren).toHaveLength(1);
  first.abort();
  // The child and the S-57 reader in its process group are killed at once.
  expect(mockChildren[0]?.kills).toEqual(["SIGKILL"]);
  if (process.platform !== "win32") {
    expect(signalled).toEqual([[-(mockChildren[0]?.pid as number), "SIGKILL"]]);
  }
  void workerBuilder(job, new AbortController().signal);
  await settle();
  expect(mockChildren).toHaveLength(1);
  mockChildren[0]?.emit("message", { ok: true });
  mockChildren[0]?.close(null, "SIGKILL");
  await expect(aborted).rejects.toThrow("aborted");
  await settle();
  expect(mockChildren).toHaveLength(2);
});

test("the process runs under a heap limit and a bounded malloc, and running out fails the build with the limit", async () => {
  const built = workerBuilder(job, new AbortController().signal);
  await settle();
  const [script, , options] = (fork as unknown as jest.Mock).mock.calls.at(-1) as [
    string,
    string[],
    { execArgv: string[]; env: NodeJS.ProcessEnv; serialization: string }
  ];
  expect(path.basename(script)).toBe("build-worker.js");
  expect(options.execArgv).toEqual([`--max-old-space-size=${workerHeapLimitMb()}`]);
  expect(options.env.MALLOC_ARENA_MAX).toBe("2");
  expect(options.serialization).toBe("advanced");
  expect(mockChildren[0]?.sent).toEqual([{ ...job, heapMb: workerHeapLimitMb() }]);
  mockChildren[0]?.stderr.emit(
    "data",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n"
  );
  mockChildren[0]?.close(null, "SIGABRT");
  await expect(built).rejects.toThrow(
    `index build stopped at the ${workerHeapLimitMb()} MB heap limit: FATAL ERROR`
  );
});

describe("only the main thread writes the index directory", () => {
  let tmp: string;
  let indexDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-worker-"));
    indexDir = path.join(tmp, "index");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const posted = (): IndexParts => {
    const fixture = fixtureIndex();
    return {
      catalogue: fixture.catalogue,
      hazards: serializeHazards(fixture.hazards),
      minZoom: fixture.pyramid.minZoom,
      leafZoom: fixture.pyramid.leafZoom,
      cols: pyramidColumns(fixture.pyramid),
      roots: { built: 1, copied: 0, nodesCopied: 0 }
    };
  };

  /** Staging named as the child with `pid` names it, half-written. */
  const childStaging = (pid: number): string => {
    const staging = `${indexDir}.tmp-${pid}-0-0badf00d`;
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "cells.json"), "{");
    return staging;
  };

  test("the build stages the index and leaves the index directory alone", async () => {
    const { staging } = await runBuild({
      dirs: [path.join(FIXTURES, "FI5SYNTH")],
      leafZoom: 14,
      indexDir,
      threads: 1
    });
    expect(fs.existsSync(indexDir)).toBe(false);
    expect(loadChartIndex(staging).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
  });

  test("a finished build is moved into the index directory and adopted as posted", async () => {
    const built = workerBuilder({ ...job, indexDir }, new AbortController().signal);
    await settle();
    const staging = stageChartIndex(indexDir, fixtureIndex());
    const index = posted();
    mockChildren[0]?.emit("message", { ok: true, staging, index });
    const read = jest.spyOn(fs.promises, "readFile");
    const done = await built;
    expect(done.catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH", "FI4SYNTH"]);
    expect(done.pyramid.dMin).toBe(index.cols.dMin);
    expect(read).not.toHaveBeenCalled();
    expect(fs.existsSync(staging)).toBe(false);
    expect(mockChildren[0]?.kills).toEqual(["SIGKILL"]);
  });

  test("a build posted without its index, as one above HELD_WHOLE_NODES is, is read from the committed files", async () => {
    const built = workerBuilder({ ...job, indexDir }, new AbortController().signal);
    await settle();
    const staging = stageChartIndex(indexDir, fixtureIndex());
    mockChildren[0]?.emit("message", { ok: true, staging });
    const done = await built;
    expect(done.catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH", "FI4SYNTH"]);
    expect(done.hazards.features()).toEqual(loadChartIndex(indexDir).hazards.features());
  });

  test("an aborted build that finishes late never replaces the index saved since", async () => {
    const first = new AbortController();
    const aborted = workerBuilder({ ...job, indexDir }, first.signal);
    await settle();
    first.abort();
    // The next start() saves its own index while the aborted process is still exiting.
    saveChartIndex(indexDir, fixtureIndex());
    const before = fs.readFileSync(path.join(indexDir, "pyramid.bin"));
    const late = stageChartIndex(indexDir, {
      ...fixtureIndex(),
      catalogue: { version: 1, cells: [] }
    });
    const half = childStaging(mockChildren[0]?.pid as number);
    mockChildren[0]?.emit("message", { ok: true, staging: late });
    mockChildren[0]?.close(null, "SIGKILL");
    await expect(aborted).rejects.toThrow("aborted");
    expect(fs.readFileSync(path.join(indexDir, "pyramid.bin"))).toEqual(before);
    expect(loadChartIndex(indexDir).catalogue.cells).toHaveLength(2);
    expect(fs.existsSync(late)).toBe(false);
    expect(fs.existsSync(half)).toBe(false);
  });

  test("a crashed build process fails the build, removes its staging and keeps the saved index", async () => {
    saveChartIndex(indexDir, fixtureIndex());
    const before = fs.readFileSync(path.join(indexDir, "pyramid.bin"));
    const built = workerBuilder({ ...job, indexDir }, new AbortController().signal);
    await settle();
    const child = mockChildren[0] as MockChild;
    const half = childStaging(child.pid);
    child.stderr.emit("data", "Segmentation fault\n");
    child.close(null, "SIGSEGV");
    await expect(built).rejects.toThrow(
      "index build process exited with signal SIGSEGV without a result: Segmentation fault"
    );
    expect(fs.existsSync(half)).toBe(false);
    expect(fs.readFileSync(path.join(indexDir, "pyramid.bin"))).toEqual(before);
  });
});

test("a build process that crashes at start leaves the engine off with the error, never normal (invariant 3)", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-crash-"));
  try {
    const saved = path.join(dataDir, "index", "pyramid.bin");
    saveChartIndex(path.dirname(saved), fixtureIndex());
    const before = fs.readFileSync(saved);
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock, globalThis.fetch, workerBuilder);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const options = { configVersion: 2, cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 };
    plugin.start({ ...options, rebuildIndex: true }, () => undefined);
    await settle();
    expect(mockChildren).toHaveLength(1);
    mockChildren[0]?.close(1);
    await settle();
    f.send(navDelta(ROCK[0], ROCK[1], 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("off");
    const status = call("/v1/status").body as { engine: { state: string; reason?: string } };
    expect(status.engine).toEqual(
      expect.objectContaining({ state: "off", reason: "chart index failed (see the server log)" })
    );
    expect(f.errors).toContain(
      "chart index failed: index build process exited with code 1 without a result"
    );
    expect(fs.readFileSync(saved)).toEqual(before);
    plugin.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
