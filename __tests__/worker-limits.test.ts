import fs from "fs";
import os from "os";
import path from "path";
import { usableMemory } from "../src/foundation/memory";
import { defaultThreads } from "../src/spatial/build-worker";
import { runBuildProcess, workerHeapLimitMb } from "../src/wfs-service";

/** Real build processes running plain JavaScript written for each test. */

/** Whether `pid` runs: a killed process whose parent has gone stays a zombie until reaped. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};

describe("build process limits", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-worker-limits-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const script = (body: string, name = "build.js"): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  test("a process past its heap limit fails with the limit named, and this process runs on", async () => {
    // Bounded, so a limit that does not apply fails the test instead of the machine.
    const hog = script(
      'process.once("message", () => {' +
        "const keep = [];" +
        "while (process.memoryUsage().heapUsed < 512 * 2 ** 20) keep.push({ a: Math.random() });" +
        'process.send({ ok: false, error: "no limit" });' +
        "});"
    );
    await expect(
      runBuildProcess(hog, {}, new AbortController().signal, undefined, 16)
    ).rejects.toThrow(/index build stopped at the 16 MB heap limit/);
  }, 30_000);

  test("a process that exits without an answer fails the build instead of leaving it pending", async () => {
    const quits = script("process.exit(3);");
    await expect(runBuildProcess(quits, {}, new AbortController().signal)).rejects.toThrow(
      "index build process exited with code 3 without a result"
    );
  });

  test("the process gets the job and its reply resolves the build", async () => {
    const echo = script(
      'process.once("message", (job) => process.send({ ok: true, staging: job.at, cols: new Float64Array([1.5]) }));'
    );
    const r = await runBuildProcess<{ ok: boolean; staging?: string; cols?: Float64Array }>(
      echo,
      { at: "here" },
      new AbortController().signal
    );
    expect(r.staging).toBe("here");
    expect(Array.from(r.cols ?? [])).toEqual([1.5]);
  });

  test("progress the process posts before its reply goes to the caller, not the result", async () => {
    const steps = script(
      'process.once("message", () => {' +
        ' process.send({ progress: { phase: "cells", done: 0, total: 2 } });' +
        ' process.send({ progress: { phase: "roots", done: 4, total: 4 } });' +
        ' process.send({ ok: true, staging: "done" });' +
        "});"
    );
    const seen: unknown[] = [];
    const r = await runBuildProcess(
      steps,
      {},
      new AbortController().signal,
      undefined,
      undefined,
      (p) => seen.push(p)
    );
    expect(r.staging).toBe("done");
    expect(seen).toEqual([
      { phase: "cells", done: 0, total: 2 },
      { phase: "roots", done: 4, total: 4 }
    ]);
  });

  (process.platform === "win32" ? test.skip : test)(
    "an abort kills the process and the reader it started, and removes their staging",
    async () => {
      const indexDir = path.join(dir, "index");
      const reader = script("setInterval(() => undefined, 1000);", "reader.js");
      const pids = path.join(dir, "pids.json");
      const build = script(
        'const fs = require("fs");' +
          'const r = require("child_process").fork(' +
          JSON.stringify(reader) +
          ', [], { stdio: "ignore" });' +
          `fs.mkdirSync(${JSON.stringify(indexDir)} + ".tmp-" + process.pid + "-0-0badf00d");` +
          `fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, r.pid]));` +
          "setInterval(() => undefined, 1000);"
      );
      const ctl = new AbortController();
      const run = runBuildProcess(build, {}, ctl.signal, indexDir);
      for (let i = 0; i < 500 && !fs.existsSync(pids); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const [child, grandchild] = JSON.parse(fs.readFileSync(pids, "utf8")) as [number, number];
      expect([isAlive(child), isAlive(grandchild)]).toEqual([true, true]);
      ctl.abort();
      await expect(run).rejects.toThrow("aborted");
      for (let i = 0; i < 100 && isAlive(grandchild); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect([isAlive(child), isAlive(grandchild)]).toEqual([false, false]);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith("index"))).toEqual([]);
    },
    30_000
  );

  test("the heap limit is a quarter of the RAM, at least 256 MB and at most 2 GB", () => {
    expect(workerHeapLimitMb(1 * 2 ** 30)).toBe(256);
    expect(workerHeapLimitMb(4 * 2 ** 30)).toBe(1024);
    expect(workerHeapLimitMb(64 * 2 ** 30)).toBe(2048);
  });

  test("a container's memory limit, not the host's RAM, is the RAM", () => {
    const GiB = 2 ** 30;
    expect(usableMemory(64 * GiB, 2 * GiB)).toBe(2 * GiB);
    // No limit set: 0, or a cgroup's "max" read as a huge number.
    expect(usableMemory(64 * GiB, 0)).toBe(64 * GiB);
    expect(usableMemory(64 * GiB, 2 ** 63)).toBe(64 * GiB);
    expect(workerHeapLimitMb(usableMemory(64 * GiB, 2 * GiB))).toBe(512);
  });

  test("one region thread with up to 4 GiB of RAM, else one per core but one, at most 4", () => {
    const GiB = 2 ** 30;
    expect([1, 2, 3.7, 4].map((g) => defaultThreads(g * GiB, 4))).toEqual([1, 1, 1, 1]);
    expect(defaultThreads(8 * GiB, 4)).toBe(3);
    expect(defaultThreads(8 * GiB, 1)).toBe(1);
    expect(defaultThreads(64 * GiB, 16)).toBe(4);
  });
});
