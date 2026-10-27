import childProcess from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import * as durable from "../src/foundation/durable-file";
import type { BuildJob } from "../src/spatial/build-worker";
import { builtReply, HELD_WHOLE_NODES, runBuild } from "../src/spatial/build-worker";
import { readCellDirectory } from "../src/ingest/cell-reader";
import { buildChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import type { IndexBuilder } from "../src/wfs-service";
import underkeel = require("../src/index");
import { CELLS, FIXTURES } from "./helpers/fixture-index";
import { fakeApp, fakeClock, T0 } from "./helpers/plugin-harness";
import { spreadCells } from "./helpers/shifted-cells";

/**
 * The off-loop index build behind the Traficom WFS box (plan §4.2, §6). The build runs in a
 * child process from the compiled lib/, which `npm run build` makes; its parts run in-process.
 */

const LIB_BUILDER = path.resolve(__dirname, "..", "lib", "wfs-service.js");
const LIB_WORKER = path.resolve(__dirname, "..", "lib", "spatial", "build-worker.js");
const LIB_STORE = path.resolve(__dirname, "..", "lib", "spatial", "store.js");
const built = fs.existsSync(LIB_BUILDER) && fs.existsSync(LIB_WORKER);
const S57 = path.resolve(__dirname, "..", "fixtures", "s57", "FI5RAW01.000");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-worker-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function job(dirs = [path.join(FIXTURES, "FI5SYNTH")]): BuildJob {
  return { dirs, leafZoom: 16, indexDir: path.join(dir, "index") };
}

describe("build process reply", () => {
  test("posts the index for a pyramid the main thread holds whole", async () => {
    const r = await runBuild({ ...job(), threads: 1 });
    expect(builtReply(r)).toEqual({ ok: true, staging: r.staging, index: r.index });
    expect(fs.existsSync(job().indexDir)).toBe(false);
  });

  test("leaves the index out above HELD_WHOLE_NODES, for the main thread to read the files", async () => {
    const r = await runBuild({ ...job(), threads: 1 });
    const big = {
      ...r.index,
      cols: { ...r.index.cols, dMin: new Float64Array(HELD_WHOLE_NODES + 1) }
    };
    expect(builtReply({ staging: r.staging, index: big })).toEqual({
      ok: true,
      staging: r.staging
    });
  });
});

describe("staging", () => {
  test("a failed reach.json write removes the staging it was written into", async () => {
    const write = jest.spyOn(durable, "writeFileDurable").mockImplementation((file) => {
      if (String(file).endsWith("reach.json")) {
        throw new Error("ENOSPC: no space left on device");
      }
    });
    try {
      await expect(runBuild({ ...job(), threads: 1 })).rejects.toThrow(/ENOSPC/);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });
});

describe("workerBuilder (compiled lib/)", () => {
  if (!built) {
    throw new Error("lib/ is not built: run `npm run build` before the tests");
  }

  async function builder(): Promise<IndexBuilder> {
    return ((await import(LIB_BUILDER)) as { workerBuilder: IndexBuilder }).workerBuilder;
  }

  test("indexes the cells in a child process and loads the result", async () => {
    const j = job();
    const index = await (await builder())(j, new AbortController().signal);
    expect(index.catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
    expect(fs.existsSync(path.join(j.indexDir, "pyramid.bin"))).toBe(true);
  });

  test("hands the index over from the build process without reading the saved files", async () => {
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
      expect(index.hazards.features()).toEqual(saved.hazards.features());
      expect(index.catalogue).toEqual(saved.catalogue);
    } finally {
      read.mockRestore();
    }
  });

  test("builds in a child process the index an in-process build makes, S-57 cells read in a reader process", async () => {
    const j = job([S57, path.join(FIXTURES, "FI5SYNTH")]);
    const phases: string[] = [];
    const index = await (
      await builder()
    )(j, new AbortController().signal, (p) =>
      phases.push(`${p.phase} ${p.done ?? ""}/${p.total ?? ""}`)
    );
    // Each phase's first and last report reach the server; the throttle drops the rest.
    expect(phases[0]).toBe("cells 0/1");
    expect(phases).toContain("cells 1/1");
    expect(phases.filter((p) => p.startsWith("roots")).pop()).toMatch(/^roots (\d+)\/\1$/);
    expect(phases[phases.length - 1]).toBe("save /");
    const { staging } = await runBuild({ ...j, indexDir: path.join(dir, "inline"), threads: 1 });
    for (const file of ["pyramid.bin", "hazards.bin", "cells.json", "reach.json"]) {
      expect(
        fs
          .readFileSync(path.join(j.indexDir, file))
          .equals(fs.readFileSync(path.join(staging, file)))
      ).toBe(true);
    }
    const inline = loadChartIndex(staging);
    const { serializePyramid } = (await import(LIB_STORE)) as {
      serializePyramid: (s: unknown) => Buffer;
    };
    expect(serializePyramid(index.pyramid).equals(serializePyramid(inline.pyramid))).toBe(true);
    expect(index.hazards.features()).toEqual(inline.hazards.features());
    expect(index.catalogue).toEqual(inline.catalogue);
    expect(index.catalogue.cells.map((c) => c.name)).toEqual(["FI5RAW01", "FI5SYNTH"]);
  });

  test("rejects with the build process's error when the build fails", async () => {
    const build = await builder();
    await expect(
      build(job([path.join(dir, "missing")]), new AbortController().signal)
    ).rejects.toThrow(/missing/);
  });

  test("rejects when aborted before the build process starts", async () => {
    const ctl = new AbortController();
    const pending = (await builder())(job(), ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  test("kills a running build process on abort and leaves no index", async () => {
    const fork = jest.spyOn(childProcess, "fork");
    try {
      const ctl = new AbortController();
      const j = job([S57, path.join(FIXTURES, "FI5SYNTH")]);
      const pending = (await builder())(j, ctl.signal);
      // One turn of the event loop lets the builder get past its wait and start the process.
      await new Promise((resolve) => setImmediate(resolve));
      expect(fork).toHaveBeenCalledTimes(1);
      ctl.abort();
      await expect(pending).rejects.toThrow("aborted");
      const child = fork.mock.results[0]?.value as childProcess.ChildProcess;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fork.mockRestore();
    }
  });

  test("stop() during the build at start kills the build process and leaves no index or staging", async () => {
    const build = await builder();
    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir);
    const plugin = underkeel(fakeApp(dataDir).app, fakeClock(T0), globalThis.fetch, build);
    // A current configuration, so no version 1 backup lands in the data directory.
    const options = { configVersion: 2, cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 };
    plugin.start(options, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    plugin.stop();
    // A build with an aborted signal settles only once every aborted build process has exited.
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
    for (const file of ["pyramid.bin", "hazards.bin", "cells.json", "reach.json"]) {
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
    for (const file of ["pyramid.bin", "hazards.bin", "cells.json", "reach.json"]) {
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
