import fs from "fs";
import os from "os";
import path from "path";
import underkeel = require("../src/index");
import { LivechartService } from "../src/livechart-service";
import { FIXTURES, M_PER_DEG_LON, ROCK } from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "./helpers/plugin-harness";

/** What the plugin answers and publishes once it is stopped or restarted. */

describe("after stop", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-lifecycle-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("a living-chart save that throws still stops the plugin and is reported", async () => {
    const save = jest.spyOn(LivechartService.prototype, "save").mockImplementation(() => {
      throw new Error("disk gone");
    });
    try {
      const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 2.0 } } });
      const plugin = underkeel(f.app, fakeClock(T0));
      const { router, post } = fakeRouter();
      plugin.registerWithRouter?.(router as never);
      plugin.start(
        { cellsDir: FIXTURES, leafZoom: 18, livechart: { enabled: true } },
        () => undefined
      );
      plugin.stop();
      expect(f.errors).toContain("living chart not saved on stop: disk gone");
      const q = { geometry: { type: "Point", coordinates: ROCK } };
      expect((await post("/v1/query", q)).code).toBe(503);
    } finally {
      save.mockRestore();
    }
  });

  test("every REST handler answers 503 instead of using the old index at chart datum", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 2.0 } } });
    const plugin = underkeel(f.app, fakeClock(T0));
    const { router, call, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start(
      {
        cellsDir: FIXTURES,
        leafZoom: 18,
        waterLevel: { source: "manual", height: -1.5, sigma: 0.05 }
      },
      () => undefined
    );
    const q = { geometry: { type: "Point", coordinates: ROCK }, draft: 2.0 };
    const route = {
      route: {
        type: "LineString",
        coordinates: [
          [22.004, 60.01],
          [22.03, 60.01]
        ]
      }
    };
    expect((await post("/v1/query", q)).code).toBe(200);
    plugin.stop();
    for (const [p, body] of [
      ["/v1/query", q],
      ["/v1/route-check", route],
      ["/v1/route-repair", route],
      ["/v1/departure-window", route],
      ["/v1/acks", {}]
    ] as const) {
      const r = await post(p, body);
      expect([p, r.code, r.body]).toEqual([p, 503, { errors: ["plugin not started"] }]);
    }
    expect(call("/v1/tiles/ukc/:z/:x/:file", {}, { z: "16", x: "0", file: "0.pbf" }).code).toBe(
      503
    );
    expect(call("/v1/acks").code).toBe(503);
    expect(call("/v1/status").body).toMatchObject({
      engine: { state: "off", reason: "plugin stopped" },
      index: { loaded: false }
    });
  });

  test("the water level and envelope rev are cleared, not left at their last values", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    plugin.start(
      { cellsDir: FIXTURES, leafZoom: 18, waterLevel: { source: "manual", height: 0.4 } },
      () => undefined
    );
    f.send(navDelta(ROCK[0] - 75 / M_PER_DEG_LON, ROCK[1], 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.waterLevel")).toBe(0.4);
    expect(lastValue(f.deltas, "navigation.underKeel.envelopeRev")).toEqual(expect.any(Number));
    plugin.stop();
    expect(lastValue(f.deltas, "navigation.underKeel.waterLevel")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.envelopeRev")).toBeNull();
  });
});

describe("restart", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-lifecycle-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("a zone load from the previous start does not report into the current one", async () => {
    const f = fakeApp(dataDir);
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => (release = r));
    const square = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0]
      ]
    ];
    (f.app as unknown as { resourcesApi: unknown }).resourcesApi = {
      getResource: async (_type: string, id: string) => {
        if (id === "old") {
          await gate;
          throw new Error("not found");
        }
        return { name: id, feature: { geometry: { type: "Polygon", coordinates: square } } };
      }
    };
    const plugin = underkeel(f.app, fakeClock(T0));
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const flush = () => new Promise((r) => setImmediate(r));
    plugin.start({ mooringZones: ["old"] }, () => undefined);
    plugin.stop();
    plugin.start({ mooringZones: ["new"] }, () => undefined);
    await flush();
    release();
    await flush();
    expect(call("/v1/status").body).toMatchObject({
      mooringZones: { loaded: ["new"], errors: [] }
    });
    plugin.stop();
  });

  test("a failed index load stays reported as the plugin error while the monitor ticks", () => {
    const f = fakeApp(dataDir);
    const reports: [string, string][] = [];
    const app = f.app as unknown as Record<string, unknown>;
    app.setPluginStatus = (m: string) => reports.push(["status", m]);
    app.setPluginError = (m: string) => reports.push(["error", m]);
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    plugin.start({ cellsDir: "/nonexistent/cells" }, () => undefined);
    clock.advance(1000);
    expect(reports.length).toBeGreaterThan(1);
    expect(reports.every(([kind]) => kind === "error")).toBe(true);
    expect(reports.at(-1)?.[1]).toMatch(/chart index failed/);
    plugin.stop();
  });

  test("an envelope rev from before a restart is never answered 304", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const run = (lon: number) => {
      plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
      f.send(navDelta(lon, ROCK[1], 3, clock.now()));
      clock.advance(1000);
      return lastValue(f.deltas, "navigation.underKeel.envelopeRev") as number;
    };
    const before = run(ROCK[0] - 75 / M_PER_DEG_LON);
    plugin.stop();
    const after = run(ROCK[0] - 300 / M_PER_DEG_LON);
    expect(Number.isSafeInteger(after)).toBe(true);
    expect(after).not.toBe(before);
    expect(call("/v1/envelope", { rev: String(before) }).code).toBe(200);
    expect(call("/v1/envelope", { rev: String(after) }).code).toBe(304);
    plugin.stop();
  });
});
