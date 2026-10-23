import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import { BOX_WAITING_REASON, cellSources, planIndex, sourceKeys } from "../src/index-loader";
import { encBounds } from "../src/ingest/enc-bounds";
import { readCell } from "../src/ingest/cell-source";
import { boxAround } from "../src/ingest/wfs";
import { boxCells, boxRect, readBox } from "../src/spatial/build-box";
import { cellReach, DEFAULT_BUILD } from "../src/spatial/build-items";
import type { BuildJob } from "../src/spatial/build-worker";
import { buildByRegion, runBuild, runRegion } from "../src/spatial/build-worker";
import { commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import { FLAGS } from "../src/spatial/node-store";
import type { NodeStore } from "../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../src/spatial/pyramid";
import type { IndexBuilder } from "../src/wfs-service";
import underkeel = require("../src/index");
import { BANK, CELLS, prepareFixtureIndex, ROCK } from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "./helpers/plugin-harness";
import { boxRing } from "./helpers/synthetic";

/**
 * The index built around the vessel (plan §4.2): only the S-57 cells that
 * reach the box are read, only its tiles built, and every tile outside it is
 * no coverage, so nothing there reads as clear (invariants 3 and 4).
 */

// Loads gdal3.js once: after that a fixture cell is read within one turn of the event loop.
beforeAll(prepareFixtureIndex);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-box-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const LEAF = 16;
const near = ([lon, lat]: LonLat, d = 0.0005) =>
  footprintGeom(boxRing([lon - d, lat - d, lon + d, lat + d]));
const at = (store: NodeStore, p: LonLat) => minDepthOver(store, near(p));

function boxJob(centre: LonLat, radiusKm: number): BuildJob {
  const dirs = cellSources(CELLS);
  return {
    dirs,
    leafZoom: LEAF,
    indexDir: path.join(dir, "index"),
    box: { bbox: boxAround(centre, radiusKm), sources: sourceKeys(dirs) }
  };
}

const inline = (job: BuildJob) => buildByRegion(job, (j) => Promise.resolve(runRegion(j)));

/** The worker's job run in-process: stage, commit and load, as workerBuilder does. */
const boxBuilder: IndexBuilder = async (job) => {
  const r = await runBuild({ ...job, threads: 1 });
  commitChartIndex(job.indexDir, r.staging);
  return loadChartIndex(job.indexDir);
};

describe("encBounds", () => {
  test("holds every feature GDAL reads from the cell", async () => {
    for (const source of cellSources(CELLS)) {
      const b = encBounds(source);
      expect(b).toBeDefined();
      const rect = boxRect(b as [number, number, number, number]);
      const reach = cellReach((await readCell(source, 0)).features, DEFAULT_BUILD).box;
      expect(reach.minX).toBeGreaterThanOrEqual(rect.minX - 1);
      expect(reach.minY).toBeGreaterThanOrEqual(rect.minY - 1);
      expect(reach.maxX).toBeLessThanOrEqual(rect.maxX + 1);
      expect(reach.maxY).toBeLessThanOrEqual(rect.maxY + 1);
    }
  });

  test("gives no extent for a file that is not S-57, so the cell is kept anywhere", () => {
    const fake = path.join(dir, "XX5FAKE1.000");
    fs.writeFileSync(fake, "not an ISO 8211 file");
    expect(encBounds(fake)).toBeUndefined();
    expect(boxCells([fake], boxAround([0, 0], 2))).toEqual([fake]);
  });

  test("leaves out the cells far from the box", () => {
    expect(boxCells(cellSources(CELLS), boxAround([10, 50], 10))).toEqual([]);
    expect(boxCells(cellSources(CELLS), boxAround(ROCK, 2))).toEqual(cellSources(CELLS));
  });
});

describe("index built in a box", () => {
  test("matches the whole build inside the box and is no coverage outside it", async () => {
    const dirs = cellSources(CELLS);
    const whole = await inline({ dirs, leafZoom: LEAF, indexDir: path.join(dir, "whole") });
    const boxed = await inline(boxJob(ROCK, 1));
    expect(at(boxed.pyramid, ROCK)).toEqual(at(whole.pyramid, ROCK));
    // BANK lies 2.3 km south of ROCK: charted in the whole build, never clear in the box's.
    // It is within chart position reach of the box, so it keeps its depth to spread risk in.
    expect(at(whole.pyramid, BANK).flags & FLAGS.NO_COVERAGE).toBe(0);
    const outside = at(boxed.pyramid, BANK);
    expect(outside.flags & FLAGS.NO_COVERAGE).not.toBe(0);
    expect(outside.coveredDMin).toBeLessThanOrEqual(at(whole.pyramid, BANK).coveredDMin);
  });

  test("past the box only the tiles within chart position reach of it are built", async () => {
    const boxed = await inline(boxJob(ROCK, 0.5));
    // 2.3 km south of ROCK is 1.8 km past a 0.5 km box: in reach, kept as no coverage.
    expect(at(boxed.pyramid, BANK).flags & FLAGS.NO_COVERAGE).not.toBe(0);
    expect(at(boxed.pyramid, BANK).coveredDMin).not.toBe(Infinity);
    // 4 km north of ROCK lies past the reach: nothing is kept there.
    const far = at(boxed.pyramid, [ROCK[0], ROCK[1] + 0.036]);
    expect(far.flags & FLAGS.NO_COVERAGE).not.toBe(0);
    expect(far.dMin).toBe(-Infinity);
  });

  test("a box away from every cell reads no cell and builds no root", async () => {
    const boxed = await inline(boxJob([10, 50], 10));
    expect(boxed.catalogue.cells).toEqual([]);
    expect(boxed.roots).toEqual({ built: 0, copied: 0 });
  });

  test("is saved with its box and the cell stamps it chose from", async () => {
    const job = boxJob(ROCK, 2);
    await boxBuilder(job, new AbortController().signal);
    expect(readBox(job.indexDir)).toEqual({ ...job.box, leafZoom: LEAF });
  });
});

describe("start plan with a box", () => {
  const config = (extra: object = {}) =>
    parseConfig({ cellsDir: CELLS, indexDir: path.join(dir, "index"), leafZoom: LEAF, ...extra });

  test("with no saved box nothing is built, and the reason says why (invariant 3)", () => {
    const p = planIndex(config(), dir);
    expect(p).toEqual({
      load: { indexDir: path.join(dir, "index"), built: false, reason: BOX_WAITING_REASON }
    });
  });

  test("an index built in a box from the same cells is loaded", async () => {
    await boxBuilder(boxJob(ROCK, 2), new AbortController().signal);
    const p = planIndex(config(), dir);
    expect("load" in p && p.load.index?.catalogue.cells.map((c) => c.name)).toEqual([
      "FI4SYNTH",
      "FI5SYNTH"
    ]);
  });

  test("changed cells rebuild in the saved box, as does rebuildIndex", async () => {
    const job = boxJob(ROCK, 2);
    await boxBuilder(
      { ...job, box: { bbox: job.box!.bbox, sources: ["an older cell"] } },
      new AbortController().signal
    );
    const p = planIndex(config(), dir);
    expect("build" in p && p.build.box).toEqual(job.box);
    await boxBuilder(job, new AbortController().signal);
    const again = planIndex(config({ rebuildIndex: true }), dir);
    expect("build" in again && again.build.box).toEqual(job.box);
  });

  test("a saved box index built at another leaf zoom is rebuilt", async () => {
    const job = boxJob(ROCK, 2);
    await boxBuilder(job, new AbortController().signal);
    const p = planIndex(config({ leafZoom: LEAF + 1 }), dir);
    expect("build" in p && p.build.leafZoom).toBe(LEAF + 1);
    expect("build" in p && p.notes).toEqual([
      `rebuilt the index: leaf zoom ${LEAF + 1} differs from the saved ${LEAF}`
    ]);
  });

  test("boxRadiusKm 0 builds every cell at start", () => {
    const p = planIndex(config({ boxRadiusKm: 0 }), dir);
    expect("build" in p && p.build.box).toBeUndefined();
  });
});

describe("plugin with the box around the vessel", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }
  };

  test("is off until a position arrives, then builds the box and follows the vessel", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dir);
    const plugin = underkeel(h.app, clock, globalThis.fetch, boxBuilder);
    plugin.start(
      {
        vessel: { draft: 2, length: 12, beam: 4 },
        cellsDir: CELLS,
        leafZoom: LEAF,
        boxRadiusKm: 2
      },
      () => undefined
    );
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).toBe("off");
    expect(h.statuses).toContain(BOX_WAITING_REASON);
    h.send(navDelta(ROCK[0], ROCK[1], 0, clock.now()));
    clock.advance(10_000);
    await settle();
    const status = call("/v1/status").body as {
      wfs: unknown;
      chartBox: { box: { radiusKm: number; catzoc?: number } };
      index: { cells: { name: string }[] };
    };
    expect(status.wfs).toBeNull();
    expect(status.chartBox.box.radiusKm).toBe(2);
    expect(status.chartBox.box.catzoc).toBeUndefined();
    expect(status.index.cells.map((c) => c.name)).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    h.send(navDelta(ROCK[0], ROCK[1], 0, clock.now()));
    clock.advance(1000);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).not.toBe("off");
    expect(h.errors).toEqual([]);
    plugin.stop();
  });
});
