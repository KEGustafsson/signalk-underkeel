import fs from "fs";
import os from "os";
import path from "path";
import { readCellDirectory } from "../src/ingest/cell-reader";
import type { FetchLike } from "../src/model/fmi";
import { buildChartIndex, loadChartIndex, saveChartIndex } from "../src/spatial/chart-index";
import type { IndexBuilder } from "../src/wfs-service";
import underkeel = require("../src/index");
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "./helpers/plugin-harness";

/** One depth area over the whole test water, 10 m. */
const fetch: FetchLike = (url) => {
  const features = url.includes("DepthArea_A")
    ? [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [21.5, 59.8],
                [22.5, 59.8],
                [22.5, 60.2],
                [21.5, 60.2],
                [21.5, 59.8]
              ]
            ]
          },
          properties: { DRVAL1: "10", IDENTIFIER: "FI 10" }
        }
      ]
    : [];
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ type: "FeatureCollection", features }))
  });
};

/** The worker's job, run in-process: ts-jest has no compiled worker file. */
const build: IndexBuilder = (job) => {
  saveChartIndex(
    job.indexDir,
    buildChartIndex(
      job.dirs.map((d, i) => readCellDirectory(d, i)),
      { leafZoom: job.leafZoom }
    )
  );
  return Promise.resolve(loadChartIndex(job.indexDir));
};

const settle = () => new Promise((r) => setImmediate(r));

describe("plugin with the Traficom WFS source", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-wfs-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("the engine is off until the first box is indexed, then alert with the notice", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    const plugin = underkeel(h.app, clock, fetch, build);
    plugin.start(
      { vessel: { draft: 2, length: 12, beam: 4 }, wfs: { enabled: true, radiusKm: 3 } },
      () => undefined
    );
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).toBe("off");
    expect(h.errors).toContain("waiting for the first Traficom WFS download");
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(1000);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).toBe("alert");
    const status = call("/v1/status").body as {
      engine: { reason: string };
      wfs: { notice: string; box: { radiusKm: number } };
      index: { cells: { name: string }[] };
    };
    expect(status.engine.reason).toMatch(/not for navigational purposes/);
    expect(status.wfs.box.radiusKm).toBe(3);
    expect(status.index.cells.map((c) => c.name)).toEqual(["FI1WFS01"]);
    plugin.stop();
  });

  test("with the source turned off, a saved index holding the WFS cell is not used", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    const plugin = underkeel(h.app, clock, fetch, build);
    plugin.start({ vessel: { draft: 2 }, wfs: { enabled: true, radiusKm: 3 } }, () => undefined);
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    plugin.stop();
    const again = fakeApp(dataDir);
    const off = underkeel(again.app, clock, fetch, build);
    off.start({ vessel: { draft: 2 } }, () => undefined);
    expect(lastValue(again.deltas, "navigation.underKeel.state")).toBe("off");
    expect(again.errors.join(" ")).toMatch(/holds Traficom WFS depths and that source is off/);
    off.stop();
  });
});
