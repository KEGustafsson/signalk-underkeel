import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import { publicReason } from "../src/foundation/public-text";
import { BOX_WAITING_REASON } from "../src/index-loader";
import { boxAround } from "../src/ingest/wfs";
import { runBuild } from "../src/spatial/build-worker";
import { commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import { readSource } from "../src/spatial/build-source";
import type { IndexBuilder, WfsBox } from "../src/wfs-service";
import underkeel = require("../src/index");
import { CELLS, prepareFixtureIndex, ROCK } from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "./helpers/plugin-harness";

/**
 * The chart box service in the running plugin: it builds whenever no index of its box is in
 * use, and with no index a failed build is reported as the error it is.
 */

// Loads gdal3.js once: after that a fixture cell is read within one turn of the event loop.
beforeAll(prepareFixtureIndex);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-box-service-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const LEAF = 16;

/** The worker's job run in-process: stage, commit and load, as workerBuilder does. */
const boxBuilder: IndexBuilder = async (job) => {
  const r = await runBuild({ ...job, threads: 1 });
  commitChartIndex(job.indexDir, r.staging);
  return loadChartIndex(job.indexDir);
};

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

function startPlugin(cellsDir: string) {
  const clock = fakeClock(T0);
  const h = fakeApp(dir);
  const plugin = underkeel(h.app, clock, globalThis.fetch, boxBuilder);
  plugin.start(
    { vessel: { draft: 2, length: 12, beam: 4 }, cellsDir, leafZoom: LEAF, boxRadiusKm: 2 },
    () => undefined
  );
  const { router, call } = fakeRouter();
  plugin.registerWithRouter?.(router as never);
  return { clock, h, plugin, call };
}

describe("chart box service", () => {
  // Builds an index with gdal3.js in-process: seconds on a slow CI runner.
  test("a saved box at the vessel with no index in use is built, not waited on", async () => {
    // As after an upgrade from a whole build, or with indexDir deleted or changed.
    const saved: WfsBox = {
      bbox: boxAround(ROCK, 2),
      centre: ROCK,
      radiusKm: 2,
      fetchedAt: new Date(T0).toISOString(),
      features: { depthAreas: 0, dredgedAreas: 0, soundings: 0 }
    };
    fs.mkdirSync(path.join(dir, "chart-box"));
    fs.writeFileSync(path.join(dir, "chart-box", "box.json"), JSON.stringify(saved));
    const { clock, h, plugin, call } = startPlugin(CELLS);
    expect(h.statuses).toContain(BOX_WAITING_REASON);
    h.send(navDelta(ROCK[0], ROCK[1], 0, clock.now()));
    clock.advance(10_000);
    const cells = () =>
      (call("/v1/status").body as { index: { cells: { name: string }[] } }).index.cells;
    // The build writes the cell cache off the event loop before it hands the index over.
    for (let i = 0; i < 500 && cells().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cells().map((c) => c.name)).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    expect(readSource(path.join(dir, "index"))).toBe(`dir:${path.resolve(CELLS)}`);
    h.send(navDelta(ROCK[0], ROCK[1], 0, clock.now()));
    clock.advance(1000);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).not.toBe("off");
    plugin.stop();
  }, 60_000);

  test("with no index in use a failed build is the reason, published as an error", async () => {
    const empty = path.join(dir, "cells");
    fs.mkdirSync(empty);
    const { clock, h, plugin, call } = startPlugin(empty);
    h.send(navDelta(ROCK[0], ROCK[1], 0, clock.now()));
    clock.advance(10_000);
    await settle();
    const why = `chart box around the vessel: no S-57 cell found in ${empty}`;
    h.errors.length = 0;
    h.statuses.length = 0;
    clock.advance(1000);
    // Not "waiting for the vessel position": the position is known and the build failed.
    expect(h.errors).toContain(why);
    expect(h.statuses).not.toContain(BOX_WAITING_REASON);
    // GET /status hides the server path; the error log has it whole.
    expect((call("/v1/status").body as { index: { reason: string } }).index.reason).toBe(
      publicReason(why)
    );
    expect(lastValue(h.deltas, "navigation.underKeel.state")).toBe("off");
    plugin.stop();
  });
});

describe("boxRadiusKm", () => {
  test("0 turns the box off; under the 2 km minimum it is raised to 2, not reset to 10", () => {
    expect(parseConfig({ boxRadiusKm: 0 }).boxRadiusKm).toBe(0);
    expect(parseConfig({ boxRadiusKm: 0.5 }).boxRadiusKm).toBe(2);
    expect(parseConfig({ boxRadiusKm: 1 }).boxRadiusKm).toBe(2);
    expect(parseConfig({ boxRadiusKm: 7 }).boxRadiusKm).toBe(7);
    expect(parseConfig({ boxRadiusKm: -1 }).boxRadiusKm).toBe(10);
    expect(parseConfig({}).boxRadiusKm).toBe(10);
  });
});
