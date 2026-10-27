import childProcess from "child_process";
import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import * as durable from "../../src/foundation/durable-file";
import type { LonLat } from "../../src/foundation/geo";
import { boxAround } from "../../src/ingest/wfs";
import type { BuildJob } from "../../src/spatial/build-worker";
import { runBuild } from "../../src/spatial/build-worker";
import { REACH_FILE } from "../../src/spatial/build-reuse";
import { commitChartIndex, loadChartIndex } from "../../src/spatial/chart-index";
import { TILES_FILE } from "../../src/spatial/tile-reuse";
import type { IndexBuilder } from "../../src/wfs-service";
import { spreadCells } from "../helpers/shifted-cells";

/**
 * A box refresh copies the saved index's tiles that lie in the same box state in the old and
 * new box and are evaluated from the same items (plan §4.2). The staged files must be the ones
 * a fresh build of the new box writes, byte for byte.
 */

const FILES = ["cells.json", "pyramid.bin", "hazards.bin", REACH_FILE, TILES_FILE];
const LEAF = 16;
const S57 = path.resolve(__dirname, "..", "..", "fixtures", "s57");
const LIB_BUILDER = path.resolve(__dirname, "..", "..", "lib", "wfs-service.js");
const LIB_WORKER = path.resolve(__dirname, "..", "..", "lib", "spatial", "build-worker.js");

let tmp: string;
let enc: string[];
let runs = 0;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-tiles-"));
  enc = spreadCells(path.join(tmp, "enc"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fresh directory under the test's temporary one. */
function scratch(): string {
  runs += 1;
  return path.join(tmp, `run-${runs}`);
}

function boxJob(indexDir: string, centre: LonLat, km: number, leafZoom = LEAF, dirs = enc) {
  const job: BuildJob = {
    dirs,
    leafZoom,
    indexDir,
    threads: 1,
    box: { bbox: boxAround(centre, km), sources: [] }
  };
  return job;
}

/** The box index of `centre` built and saved in `indexDir`. */
async function saveBox(indexDir: string, centre: LonLat, km: number, leafZoom = LEAF, dirs = enc) {
  const r = await runBuild(boxJob(indexDir, centre, km, leafZoom, dirs));
  commitChartIndex(indexDir, r.staging);
}

/** Names of the files that differ between two index directories. */
function differing(a: string, b: string): string[] {
  return FILES.filter(
    (f) => !fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))
  );
}

const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(dir, f)).toString("base64")])
  );

/**
 * The box of `centre` built reusing the index saved in `saved`, and built afresh: the reusing
 * build's root counts and the files in which the two differ.
 */
async function rebuilt(saved: string, centre: LonLat, km: number, leafZoom = LEAF, dirs = enc) {
  const reused = await runBuild(boxJob(saved, centre, km, leafZoom, dirs));
  const fresh = await runBuild(boxJob(scratch(), centre, km, leafZoom, dirs));
  const result = { roots: reused.index.roots, differ: differing(reused.staging, fresh.staging) };
  fs.rmSync(reused.staging, { recursive: true, force: true });
  fs.rmSync(fresh.staging, { recursive: true, force: true });
  return result;
}

/** `p` moved `east` and `north` km. */
const moved = ([lon, lat]: LonLat, east: number, north: number): LonLat => [
  lon + east / (111.32 * Math.cos((lat * Math.PI) / 180)),
  lat + north / 111.2
];

describe("box refresh reusing the saved box index's tiles", () => {
  test("random moves and resizes over the cells give the fresh build's files", async () => {
    let copying = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 21.99, max: 22.42, noNaN: true }),
        fc.double({ min: 59.98, max: 60.08, noNaN: true }),
        fc.double({ min: 0.8, max: 2.5, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 1.5, noNaN: true }),
        fc.double({ min: 0.7, max: 1.4, noNaN: true }),
        // A cell the saved build lacked, as one an S-57 box leaves out, and a cell changed since.
        fc.option(fc.nat(enc.length - 1)),
        fc.option(fc.nat(enc.length - 1)),
        async (lon, lat, km, angle, step, resize, lacked, changed) => {
          const saved = scratch();
          const from: LonLat = [lon, lat];
          await saveBox(
            saved,
            from,
            km,
            LEAF,
            enc.filter((_, i) => i !== lacked)
          );
          const d = step * km;
          const to = moved(from, d * Math.cos(angle), d * Math.sin(angle));
          const depare =
            changed === null ? undefined : path.join(enc[changed] as string, "DEPARE.geojson");
          const depths = depare && fs.readFileSync(depare, "utf8");
          try {
            if (depare && depths) {
              fs.writeFileSync(depare, depths.replace(/"DRVAL1":\s*\d+(\.\d+)?/g, '"DRVAL1":0.3'));
            }
            const r = await rebuilt(saved, to, km * resize);
            copying += r.roots.nodesCopied > 0 ? 1 : 0;
            return r.differ.length === 0;
          } finally {
            if (depare && depths) {
              fs.writeFileSync(depare, depths);
            }
          }
        }
      ),
      { numRuns: 40 }
    );
    // Most moves copy something: the property holds on copied tiles, not only on fresh ones.
    expect(copying).toBeGreaterThan(10);
  }, 60_000);

  test("a box moved by a fifth of its radius copies whole roots inside both boxes", async () => {
    const saved = scratch();
    // Root (575, 297) at z10, 22.15–22.5° E and 59.89–60.07° N, lies inside both 14 km boxes.
    const from: LonLat = [22.324, 59.977];
    await saveBox(saved, from, 14, 13);
    const r = await rebuilt(saved, moved(from, 2.8, 0), 14, 13);
    expect(r).toMatchObject({ differ: [], roots: { copied: 1 } });
  });

  test("a changed cell keeps the roots and tiles it reaches from being copied", async () => {
    const from: LonLat = [22.324, 59.977];
    const to = moved(from, 2.8, 0);
    const saved = scratch();
    await saveBox(saved, from, 14, 13);
    const before = await rebuilt(saved, to, 14, 13);
    // FI5SH3 lies in the whole root copied above; FI5SH1 in a root whose tiles are copied.
    const cells = ["FI5SH3", "FI5SH1"].map((name) => enc.find((d) => d.endsWith(name)) as string);
    const files = cells.map((c) => path.join(c, "DEPARE.geojson"));
    const depths = files.map((f) => fs.readFileSync(f, "utf8"));
    try {
      files.forEach((f, i) =>
        fs.writeFileSync(
          f,
          (depths[i] as string).replace(/"DRVAL1":\s*\d+(\.\d+)?/, '"DRVAL1":0.4')
        )
      );
      const after = await rebuilt(saved, to, 14, 13);
      expect(after.differ).toEqual([]);
      expect(after.roots.copied).toBe(0);
      expect(after.roots.nodesCopied).toBeGreaterThan(0);
      expect(after.roots.nodesCopied).toBeLessThan(before.roots.nodesCopied);
    } finally {
      files.forEach((f, i) => fs.writeFileSync(f, depths[i] as string));
    }
  });

  test("an S-57 cell replaced under its name is read again, not copied", async () => {
    const cells = path.join(scratch(), "cells");
    fs.mkdirSync(cells, { recursive: true });
    for (const f of ["FI4SYNTH.000", "FI5SYNTH.000"]) {
      fs.copyFileSync(path.join(S57, "synth", f), path.join(cells, f));
    }
    const dirs = ["FI4SYNTH.000", "FI5SYNTH.000"].map((f) => path.join(cells, f));
    const saved = scratch();
    const from: LonLat = [22.015, 60.005];
    await saveBox(saved, from, 1.5, LEAF, dirs);
    const to = moved(from, 0.6, 0.3);
    const before = await rebuilt(saved, to, 1.5, LEAF, dirs);
    expect(before.differ).toEqual([]);
    expect(before.roots.nodesCopied).toBeGreaterThan(0);
    // Another cell's bytes under FI5SYNTH's name: a new stamp, and depths the saved nodes lack.
    fs.copyFileSync(path.join(S57, "FI5RAW01.000"), path.join(cells, "FI5SYNTH.000"));
    const after = await rebuilt(saved, to, 1.5, LEAF, dirs);
    expect(after.differ).toEqual([]);
    expect(after.roots.nodesCopied).toBeLessThan(before.roots.nodesCopied);
  });

  const from: LonLat = [22.03, 60.0];
  const to = moved(from, 0.8, 0.4);

  test("a saved index left as built is copied from", async () => {
    const saved = scratch();
    await saveBox(saved, from, 2);
    const r = await rebuilt(saved, to, 2);
    expect(r.differ).toEqual([]);
    expect(r.roots.nodesCopied).toBeGreaterThan(0);
  });

  test.each<[string, (saved: string) => Promise<void> | void]>([
    ["another leaf zoom", async (saved) => saveBox(saved, from, 2, LEAF - 1)],
    [
      "a tiles file from another plugin or pyramid version",
      (saved) => {
        const file = path.join(saved, TILES_FILE);
        const json = JSON.parse(fs.readFileSync(file, "utf8")) as { stamp: string };
        fs.writeFileSync(file, JSON.stringify({ ...json, stamp: `${json.stamp} other` }));
      }
    ],
    [
      "the tiles file of another index",
      async (saved) => {
        const other = scratch();
        await saveBox(other, to, 2);
        fs.copyFileSync(path.join(other, TILES_FILE), path.join(saved, TILES_FILE));
      }
    ],
    ["no tiles file", (saved) => fs.rmSync(path.join(saved, TILES_FILE))],
    ["a torn tiles file", (saved) => fs.truncateSync(path.join(saved, TILES_FILE), 30)]
  ])("with %s nothing is copied", async (_, spoil) => {
    const saved = scratch();
    await saveBox(saved, from, 2);
    await spoil(saved);
    const r = await rebuilt(saved, to, 2);
    expect(r).toMatchObject({ differ: [], roots: { copied: 0, nodesCopied: 0 } });
  });

  test("a reusing build that fails keeps the saved index and leaves no staging", async () => {
    const parent = scratch();
    const saved = path.join(parent, "index");
    await saveBox(saved, from, 2);
    const kept = snapshot(saved);
    const write = jest.spyOn(durable, "writeFileDurable").mockImplementation((file) => {
      if (String(file).endsWith(TILES_FILE)) {
        throw new Error("ENOSPC: no space left on device");
      }
    });
    try {
      await expect(runBuild(boxJob(saved, to, 2))).rejects.toThrow(/ENOSPC/);
    } finally {
      write.mockRestore();
    }
    expect(snapshot(saved)).toEqual(kept);
    expect(fs.readdirSync(parent)).toEqual(["index"]);
    expect(loadChartIndex(saved).catalogue.cells).toHaveLength(enc.length);
  });
});

describe("box refresh in the build process (compiled lib/)", () => {
  if (!fs.existsSync(LIB_BUILDER) || !fs.existsSync(LIB_WORKER)) {
    throw new Error("lib/ is not built: run `npm run build` before the tests");
  }

  test("an aborted reusing build keeps the saved index", async () => {
    const { workerBuilder } = (await import(LIB_BUILDER)) as { workerBuilder: IndexBuilder };
    const parent = scratch();
    const saved = path.join(parent, "index");
    await saveBox(saved, [22.03, 60.0], 2);
    const kept = snapshot(saved);
    const fork = jest.spyOn(childProcess, "fork");
    try {
      const ctl = new AbortController();
      const pending = workerBuilder(boxJob(saved, [22.04, 60.004], 2), ctl.signal);
      await new Promise((resolve) => setImmediate(resolve));
      expect(fork).toHaveBeenCalledTimes(1);
      ctl.abort();
      await expect(pending).rejects.toThrow("aborted");
    } finally {
      fork.mockRestore();
    }
    expect(snapshot(saved)).toEqual(kept);
    expect(fs.readdirSync(parent)).toEqual(["index"]);
  });

  test("region threads copy the same tiles a single thread does", async () => {
    const lib = (await import(LIB_WORKER)) as {
      runBuild: (j: BuildJob) => Promise<{ staging: string; index: { roots: object } }>;
    };
    const saved = scratch();
    await saveBox(saved, [22.03, 60.0], 2);
    const job = { ...boxJob(saved, [22.045, 60.006], 2), threads: 3 };
    const three = await lib.runBuild(job);
    const one = await runBuild({ ...job, threads: 1 });
    expect(three.index.roots).toEqual(one.index.roots);
    expect(three.index.roots).toMatchObject({ nodesCopied: expect.any(Number) });
    expect((one.index.roots as { nodesCopied: number }).nodesCopied).toBeGreaterThan(0);
    expect(differing(three.staging, one.staging)).toEqual([]);
  });
});
