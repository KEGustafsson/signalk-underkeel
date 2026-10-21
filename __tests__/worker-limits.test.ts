import fs from "fs";
import os from "os";
import path from "path";
import { usableMemory } from "../src/foundation/memory";
import { runWorker, workerHeapLimitMb } from "../src/wfs-service";

/** Real worker threads running plain JavaScript written for each test. */

/** V8 flags are process-wide: `--max-old-space-size` overrides a worker's resourceLimits. */
const heapFlag = /--max-old-space-size/.test(
  `${process.env.NODE_OPTIONS ?? ""} ${process.execArgv.join(" ")}`
);

describe("build worker limits", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-worker-limits-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const script = (body: string): string => {
    const file = path.join(dir, "worker.js");
    fs.writeFileSync(file, body);
    return file;
  };

  (heapFlag ? test.skip : test)(
    "a worker past its heap limit fails with the limit named, and the process runs on",
    async () => {
      // Bounded, so a limit that does not apply fails the test instead of the machine.
      const hog = script(
        "const keep = [];" +
          "while (process.memoryUsage().heapUsed < 512 * 2 ** 20) keep.push({ a: Math.random() });" +
          'require("worker_threads").parentPort.postMessage({ ok: false, error: "no limit" });'
      );
      await expect(runWorker(hog, {}, new AbortController().signal, undefined, 16)).rejects.toThrow(
        /index build stopped at the 16 MB worker heap limit/
      );
    },
    30_000
  );

  test("a worker that exits without an answer fails the build instead of leaving it pending", async () => {
    const quits = script("process.exit(3);");
    await expect(runWorker(quits, {}, new AbortController().signal)).rejects.toThrow(
      "index build worker exited with code 3 without a result"
    );
  });

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
});
