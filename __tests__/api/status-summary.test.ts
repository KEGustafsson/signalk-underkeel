import fs from "fs";
import os from "os";
import path from "path";
import UKC = require("../../public/ukc-shared.js");
import underkeel = require("../../src/index");
import { CELLS, prepareFixtureIndex, seedFixtureIndex } from "../helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, T0 } from "../helpers/plugin-harness";

beforeAll(prepareFixtureIndex);

/** `GET /status?summary`: the status a frequent poll needs, without the per-cell lists. */

describe("status summary", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-status-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("drops the cell catalogue and datum list and keeps every field the panel reads", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.8 } } });
    const plugin = underkeel(f.app, fakeClock(T0));
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    type Status = {
      index: { cells?: unknown[] };
      waterLevel: { datums?: unknown[] };
      engine: { state: string };
    };
    const full = call("/v1/status").body as Status;
    const summary = call("/v1/status", { summary: "" }).body as Status;
    expect(full.index.cells).toHaveLength(2);
    expect(full.waterLevel.datums).toHaveLength(2);
    const { cells: _cells, ...index } = full.index;
    const { datums: _datums, ...waterLevel } = full.waterLevel;
    expect(summary).toEqual({ ...full, index, waterLevel });
    expect(summary.engine.state).toBe(full.engine.state);
    expect(UKC.statusLines(summary, "m")).toEqual(UKC.statusLines(full, "m"));
    expect(UKC.waterSourceKey(summary)).toBe(UKC.waterSourceKey(full));
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length);
    plugin.stop();
    expect(call("/v1/status", { summary: "" }).body).toMatchObject({
      engine: { state: "off", reason: "plugin stopped" }
    });
  });
});
