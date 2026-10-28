import fs from "fs";
import os from "os";
import path from "path";
import { buildManifest } from "../src/api/manifest";
import * as loader from "../src/index-loader";
import { loadOrBuildIndex } from "../src/index-loader";
import { parseConfig } from "../src/config";
import { sweepFor, DEFAULT_LOOKAHEAD } from "../src/engine/lookahead";
import underkeel = require("../src/index");
import { tileAt, toMercator } from "../src/foundation/geo";
import type { BuildJob } from "../src/spatial/build-worker";
import type { ChartIndex } from "../src/spatial/chart-index";
import { PYRAMID_VERSION } from "../src/spatial/store";
import type { IndexBuilder } from "../src/wfs-service";
import {
  CELLS,
  fixtureIndex,
  inlineBuilder,
  M_PER_DEG_LON,
  prepareFixtureIndex,
  ROCK,
  seedFixtureIndex
} from "./helpers/fixture-index";
import { decodeMvt } from "./helpers/mvt-decode";
import {
  fakeApp,
  fakeClock,
  fakeRouter,
  lastValue,
  navDelta,
  notificationCount,
  T0
} from "./helpers/plugin-harness";

beforeAll(prepareFixtureIndex);

const settle = () => new Promise((r) => setImmediate(r));

/** An index builder that settles only when the test says so, and records its abort signal. */
function deferredBuilder() {
  const calls: { job: BuildJob; signal: AbortSignal }[] = [];
  let finish: (r: { index?: ChartIndex; error?: Error }) => void = () => undefined;
  const build: IndexBuilder = (job, signal) => {
    calls.push({ job, signal });
    return new Promise((resolve, reject) => {
      finish = (r) => (r.index ? resolve(r.index) : reject(r.error));
    });
  };
  return { build, calls, finish: (r: { index?: ChartIndex; error?: Error }) => finish(r) };
}

describe("index build at start (plan §6: off the event loop)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-startup-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const status = (call: ReturnType<typeof fakeRouter>["call"]) =>
    call("/v1/status").body as {
      engine: { state: string; reason?: string };
      index: { loaded: boolean };
    };

  test("start() returns while the index builds, off with the reason, then follows the index", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const b = deferredBuilder();
    const plugin = underkeel(f.app, clock, globalThis.fetch, b.build);
    const { router, call, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    expect(b.calls.map((c) => c.job.dirs.map((d) => path.basename(d)))).toEqual([
      ["FI4SYNTH.000", "FI5SYNTH.000"]
    ]);
    f.send(navDelta(ROCK[0] - 110 / M_PER_DEG_LON, ROCK[1], 3, T0));
    for (let t = 1; t <= 3; t++) {
      clock.advance(1000);
      await settle();
      expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("off");
    }
    expect(f.statuses).toContain("building chart index");
    expect(f.errors).not.toContain("building chart index");
    expect(status(call)).toMatchObject({
      engine: { state: "off", reason: "building chart index" },
      index: { loaded: false }
    });
    const q = { geometry: { type: "Point", coordinates: ROCK } };
    expect(await post("/v1/query", q)).toEqual({
      code: 503,
      body: { errors: ["building chart index"] }
    });

    await inlineBuilder(b.calls[0]!.job, new AbortController().signal).then((index) =>
      b.finish({ index })
    );
    await settle();
    f.send(navDelta(ROCK[0] - 110 / M_PER_DEG_LON, ROCK[1], 3, clock.now()));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alarm");
    expect(status(call).index.loaded).toBe(true);
    plugin.stop();
  });

  test("a failed build keeps the engine off with the build error", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const b = deferredBuilder();
    const plugin = underkeel(f.app, clock, globalThis.fetch, b.build);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    b.finish({ error: new Error("worker out of memory") });
    await settle();
    f.send(navDelta(ROCK[0] - 110 / M_PER_DEG_LON, ROCK[1], 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("off");
    // The plugin error, which only an admin sees, keeps the build error; the wire does not.
    expect(f.errors).toContain("chart index failed: worker out of memory");
    expect(status(call).engine.reason).toBe("chart index failed (see the server log)");
    plugin.stop();
  });

  test("stop() during the build aborts it, and a late result is not used", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const b = deferredBuilder();
    const plugin = underkeel(f.app, clock, globalThis.fetch, b.build);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    plugin.stop();
    expect(b.calls[0]?.signal.aborted).toBe(true);
    b.finish({ index: fixtureIndex() });
    await settle();
    expect(status(call).engine).toMatchObject({ state: "off", reason: "plugin stopped" });
  });

  /** Makes start() read any saved index off the event loop, as it does one over 1 MB. */
  function readEverySavedIndex(): jest.SpyInstance {
    const plan = loader.planIndex;
    return jest
      .spyOn(loader, "planIndex")
      .mockImplementation((cfg, data, extra) => plan(cfg, data, extra, 0));
  }

  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  test("a large saved index is read off the event loop: off with the reason, then the index", async () => {
    seedFixtureIndex(dataDir);
    const spy = readEverySavedIndex();
    try {
      const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
      const clock = fakeClock(T0);
      const b = deferredBuilder();
      const plugin = underkeel(f.app, clock, globalThis.fetch, b.build);
      const { router, call } = fakeRouter();
      plugin.registerWithRouter?.(router as never);
      plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
      expect(status(call)).toMatchObject({
        engine: { state: "off", reason: "loading chart index" },
        index: { loaded: false }
      });
      await until(() => status(call).index.loaded);
      expect(b.calls).toEqual([]);
      f.send(navDelta(ROCK[0] - 110 / M_PER_DEG_LON, ROCK[1], 3, clock.now()));
      clock.advance(1000);
      expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alarm");
      plugin.stop();
    } finally {
      spy.mockRestore();
    }
  });

  test("a large saved index that fails to read is rebuilt, off all along", async () => {
    seedFixtureIndex(dataDir);
    const file = path.join(dataDir, "index", "pyramid.bin");
    fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
    const spy = readEverySavedIndex();
    try {
      const f = fakeApp(dataDir);
      const clock = fakeClock(T0);
      const b = deferredBuilder();
      const plugin = underkeel(f.app, clock, globalThis.fetch, b.build);
      const { router, call } = fakeRouter();
      plugin.registerWithRouter?.(router as never);
      plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
      await until(() => b.calls.length > 0);
      clock.advance(1000);
      expect(status(call).engine).toMatchObject({ state: "off", reason: "building chart index" });
      b.finish({ index: await inlineBuilder(b.calls[0]!.job, new AbortController().signal) });
      await until(() => status(call).index.loaded);
      expect((call("/v1/status").body as { index: { reason: string } }).index.reason).toMatch(
        /could not be read \(pyramid file is truncated\)/
      );
      plugin.stop();
    } finally {
      spy.mockRestore();
    }
  });

  test("a saved index that matches the cells is loaded at start without a build", () => {
    seedFixtureIndex(dataDir);
    const f = fakeApp(dataDir);
    const b = deferredBuilder();
    const plugin = underkeel(f.app, fakeClock(T0), globalThis.fetch, b.build);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    expect(b.calls).toEqual([]);
    expect(status(call).index.loaded).toBe(true);
    plugin.stop();
  });
});

describe("plugin lifecycle", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-plugin-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("identifies itself and carries the advisory disclaimer", () => {
    const plugin = underkeel(fakeApp(dataDir).app);
    expect(plugin.id).toBe("signalk-underkeel");
    expect(plugin.name).toBe("Under-Keel Awareness");
    expect(plugin.description).toMatch(/not for navigation/);
  });

  test("read routes are open to readonly users", () => {
    const plugin = underkeel(fakeApp(dataDir).app, fakeClock(T0));
    const { router, levels } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    expect(Object.fromEntries(levels)).toEqual({
      "GET /v1/status": "readonly",
      "GET /v1/envelope": "readonly",
      "POST /v1/route-check": "readonly",
      "POST /v1/route-repair": "readonly",
      "POST /v1/departure-window": "readonly",
      "POST /v1/query": "readonly",
      "GET /v1/tiles/ukc/:z/:x/:file": "readonly",
      "GET /v1/tiles/ukc/changes": "readonly",
      "GET /v1/ukc-style.json": "readonly",
      "GET /v1/acks": "readonly",
      "GET /v1/livechart/discrepancies": "readonly",
      "GET /v1/livechart/csb.geojson": "readonly",
      "POST /v1/acks": "readwrite",
      "DELETE /v1/acks/:id": "readwrite"
    });
  });

  test("without a chart index the state is off with a reason, never normal", () => {
    const f = fakeApp(dataDir);
    const plugin = underkeel(f.app, fakeClock(T0));
    // A server without the access API still gets the routes.
    const { router, call } = fakeRouter(false);
    plugin.registerWithRouter?.(router as never);
    expect(call("/v1/status").body).toMatchObject({
      engine: { state: "off", reason: "plugin not started" }
    });
    expect(call("/v1/envelope").body).toMatchObject({ rev: 0 });
    plugin.start({}, () => undefined);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("off");
    expect(f.errors[0]).toMatch(/no chart index/);
    const n = lastValue(f.deltas, "notifications.navigation.underKeel") as {
      state: string;
      message: string;
    };
    expect(n.state).toBe("alert");
    expect(n.message).toMatch(/UKC monitoring off: no chart index/);
    plugin.stop();
  });

  test("builds the index, follows the vessel and raises the look-ahead notification", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock, globalThis.fetch, inlineBuilder);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    await settle();

    expect(fs.existsSync(path.join(dataDir, "index", "pyramid.bin"))).toBe(true);
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("unknown");

    // 110 m west of the rock at 3 m/s: the rock is ~35 s ahead, still room to turn away.
    const lon = ROCK[0] - 110 / M_PER_DEG_LON;
    f.send(navDelta(lon, ROCK[1], 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alarm");
    expect(lastValue(f.deltas, "navigation.underKeel.waterLevel")).toBe(0);
    const escape = lastValue(f.deltas, "navigation.underKeel.escapeHeading") as number;
    expect(escape).toBeGreaterThanOrEqual(0);
    expect(escape).toBeLessThan(2 * Math.PI);
    const n = lastValue(f.deltas, "notifications.navigation.underKeel") as {
      state: string;
      message: string;
    };
    expect(n.state).toBe("alarm");
    // The rock's LNAM: AGEN 550, FIDN 1009, FIDS 1 in fixtures/s57/generate.js.
    expect(n.message).toMatch(/UWTROC 0226000003F10001/);
    const rev = lastValue(f.deltas, "navigation.underKeel.envelopeRev") as number;
    expect(rev).toBeGreaterThan(0);

    const status = call("/v1/status").body as {
      engine: { state: string };
      index: { loaded: boolean; cells: { name: string }[] };
      lookahead: { timeToShoal: number };
    };
    expect(status.engine.state).toBe("alarm");
    expect(status.index.loaded).toBe(true);
    expect(status.index.cells.map((c) => c.name)).toEqual(["FI4SYNTH", "FI5SYNTH"]);
    expect(status.lookahead.timeToShoal).toBeLessThanOrEqual(30);

    const env = call("/v1/envelope");
    expect(env.code).toBe(200);
    expect((env.body as { rev: number }).rev).toBe(rev);
    expect(call("/v1/envelope", { rev: String(rev) }).code).toBe(304);

    // The same alarm is not re-sent every tick.
    const before = notificationCount(f.deltas);
    f.send(navDelta(lon, ROCK[1], 3, T0 + 1000));
    clock.advance(1000);
    expect(notificationCount(f.deltas)).toBe(before);

    // The position goes stale: unknown, never normal.
    clock.advance(11_000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("unknown");

    plugin.stop();
    expect(f.unsubscribed()).toBe(1);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("off");
    expect(call("/v1/status").body).toMatchObject({
      engine: { state: "off", reason: "plugin stopped" }
    });
  });

  test("over land the clearance is published as null, never a non-finite number", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.9 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    // West of the fixture island (22.025–22.03 E, 60.013–60.016 N), heading onto it.
    f.send(navDelta(22.022, 60.0145, 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alarm");
    expect(lastValue(f.deltas, "navigation.underKeel.clearance")).toBeNull();
    const published = f.deltas.flatMap((d) =>
      (d.updates ?? []).flatMap((u) => ("values" in u ? u.values : []))
    );
    const nonFinite = published.filter(
      (pv) => typeof pv.value === "number" && !Number.isFinite(pv.value)
    );
    expect(nonFinite).toEqual([]);
    plugin.stop();
  });

  test("applies the FMI level, and falls back with a reason when the feed goes stale", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const clock = fakeClock(T0);
    let up = true;
    const urls: string[] = [];
    const fetch = (url: string) => {
      urls.push(url);
      const forecast = url.includes("forecast");
      const body = `<wfs:FeatureCollection>${[-1, 0, 1, 2]
        .map(
          (
            k
          ) => `<BsWfs:BsWfsElement><BsWfs:Time>${new Date(T0 + k * 3600000).toISOString()}</BsWfs:Time>
          <BsWfs:ParameterName>SeaLevel</BsWfs:ParameterName><BsWfs:ParameterValue>30</BsWfs:ParameterValue></BsWfs:BsWfsElement>`
        )
        .join("")}</wfs:FeatureCollection>`;
      return Promise.resolve({
        ok: up && forecast,
        status: up && forecast ? 200 : 503,
        text: () => Promise.resolve(body)
      });
    };
    const plugin = underkeel(f.app, clock, fetch);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start(
      {
        cellsDir: CELLS,
        boxRadiusKm: 0,
        leafZoom: 18,
        waterLevel: { source: "fmi", datums: [{ verdat: 13, series: "mw", sigma: 0.05 }] }
      },
      () => undefined
    );
    const flush = () => new Promise((r) => setImmediate(r));
    const at = (t: number) => {
      f.send(navDelta(22.005, 60.015, 1, t));
      clock.advance(t - clock.now());
    };

    at(T0 + 1000);
    expect(urls.length).toBe(2);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alert");
    await flush();
    // The fallback alert clears only after five ticks below its threshold (hysteresis).
    for (let k = 2; k <= 5; k++) {
      at(T0 + k * 1000);
      expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alert");
    }
    at(T0 + 6000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("normal");
    expect(lastValue(f.deltas, "navigation.underKeel.waterLevel")).toBeCloseTo(0.3, 9);
    const status = call("/v1/status").body as {
      waterLevel: { source: string; health: { ok: boolean }; applied: { h: number; note: string } };
    };
    expect(status.waterLevel).toMatchObject({ source: "fmi", health: { ok: true } });
    expect(status.waterLevel.applied.note).toBe("vertical datum unknown for FI4SYNTH");

    up = false;
    clock.advance(31 * 60000);
    at(clock.now() + 1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alert");
    const n = lastValue(f.deltas, "notifications.navigation.underKeel") as { message: string };
    expect(n.message).toMatch(/water level from fmi is 31 min old/);
    plugin.stop();
    await flush();
  });

  test("a GNSS jump raises notifications.navigation.positionIntegrity and widens the buffer", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    const integrity = () =>
      lastValue(f.deltas, "notifications.navigation.positionIntegrity") as {
        state: string;
        message: string;
        data: { sigmaPos: number };
      };
    const step = (t: number, north: number) => {
      const at = T0 + t * 1000;
      const lon = 22.005 + (3 * t) / M_PER_DEG_LON;
      const d = navDelta(lon, 60.015 + north / 111320, 3, at);
      d.updates[0]?.values.push({ path: "navigation.speedThroughWater" as never, value: 3 });
      f.send(d);
      clock.advance(at - clock.now());
    };
    for (let t = 1; t <= 10; t++) {
      step(t, 0);
    }
    expect(integrity()).toMatchObject({
      state: "normal",
      message: "Position integrity: GNSS agrees with dead reckoning"
    });
    step(11, 400);
    expect(integrity().state).toBe("warn");
    expect(integrity().message).toMatch(
      /^Position integrity degraded: GNSS and dead reckoning differ by 4\d\d m$/
    );
    expect(integrity().data.sigmaPos).toBeGreaterThan(390);
    plugin.stop();
    // A raised integrity warning does not outlive the plugin.
    expect(integrity()).toMatchObject({ state: "normal", message: "UKC monitoring stopped" });
  });

  test("an acknowledged passage turns warn into alert until it is deleted", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, call, post, del } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    expect((await post("/v1/acks", {})).code).toBe(503);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    // Held 100 s of travel west of the rock in the fairway: warn.
    const lon = ROCK[0] - 300 / M_PER_DEG_LON;
    const tick = () => {
      f.send(navDelta(lon, ROCK[1], 3, clock.now() + 1000));
      clock.advance(1000);
      return lastValue(f.deltas, "navigation.underKeel.state");
    };
    expect(tick()).toBe("warn");

    expect((await post("/v1/acks", { sector: 200 })).code).toBe(400);
    const made = await post("/v1/acks", { ttl: 3600, notificationId: "n1" });
    expect(made.code).toBe(201);
    const ack = made.body as { id: string; draft: number; heading: number; polygon: unknown[] };
    expect(ack).toMatchObject({ draft: 3.2, heading: Math.PI / 2 });
    expect(ack.polygon.length).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(path.join(dataDir, "acks.json"))).toBe(true);
    expect(tick()).toBe("alert");
    const n = lastValue(f.deltas, "notifications.navigation.underKeel") as { message: string };
    expect(n.message).toMatch(/acknowledged passage/);
    expect((call("/v1/acks").body as unknown[]).length).toBe(1);

    expect((await del("/v1/acks/:id", { id: ack.id })).code).toBe(204);
    expect((await del("/v1/acks/:id", { id: ack.id })).code).toBe(404);
    // Raising back to warn takes two ticks (hysteresis).
    tick();
    expect(tick()).toBe("warn");
    plugin.stop();
  });

  test("an acknowledgement is neither made nor honoured on a fallback water level", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.0 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start(
      {
        cellsDir: CELLS,
        boxRadiusKm: 0,
        leafZoom: 18,
        waterLevel: { source: "signalk-tide", sigma: 0.05 }
      },
      () => undefined
    );
    const lon = ROCK[0] - 300 / M_PER_DEG_LON;
    const tick = (tide: boolean) => {
      const d = navDelta(lon, ROCK[1], 3, clock.now() + 1000);
      if (tide) {
        d.updates[0]?.values.push({ path: "environment.tide.heightNow" as never, value: -0.4 });
      }
      f.send(d);
      clock.advance(1000);
      return lastValue(f.deltas, "navigation.underKeel.state");
    };
    // No tide received yet: the level is the chart-datum fallback.
    expect(tick(false)).toBe("warn");
    const refused = await post("/v1/acks", {});
    expect(refused.code).toBe(409);
    expect((refused.body as { errors: string[] }).errors[0]).toMatch(/water level degraded/);

    tick(true);
    expect(tick(true)).toBe("warn");
    const made = await post("/v1/acks", {});
    expect(made.code).toBe(201);
    expect((made.body as { waterLevel: number }).waterLevel).toBe(-0.4);
    expect(tick(true)).toBe("alert");

    // The tide feed goes stale: the 0 m fallback is above the acknowledged -0.4 m, but a guess.
    clock.advance(31 * 60_000);
    tick(false);
    expect(tick(false)).toBe("warn");
    const n = lastValue(f.deltas, "notifications.navigation.underKeel") as { message: string };
    expect(n.message).not.toMatch(/acknowledged passage/);
    plugin.stop();
  });

  test("an acknowledgement that cannot be saved answers 500 without the file path", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, post, del } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    f.send(navDelta(ROCK[0] - 300 / M_PER_DEG_LON, ROCK[1], 3, clock.now() + 1000));
    clock.advance(1000);
    const made = await post("/v1/acks", {});
    expect(made.code).toBe(201);
    // A directory where the temporary file goes makes every save throw.
    fs.mkdirSync(path.join(dataDir, `acks.json.tmp-${process.pid}`));
    const failed = { code: 500, body: { errors: ["could not save acknowledgements"] } };
    expect(await post("/v1/acks", {})).toEqual(failed);
    expect(await del("/v1/acks/:id", { id: (made.body as { id: string }).id })).toEqual(failed);
    expect(f.errors.filter((e) => /acks\.json/.test(e))).toHaveLength(2);
    plugin.stop();
  });

  test("the grounding detector is off by default and writes notifications.grounding when on", () => {
    // Seeded once: a block read the first run started may still hold the index open, and
    // Windows refuses to rename a directory with an open file in it.
    seedFixtureIndex(dataDir);
    const run = (options: Record<string, unknown>) => {
      const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.8 } } });
      const clock = fakeClock(T0);
      const plugin = underkeel(f.app, clock);
      plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18, ...options }, () => undefined);
      const at = (t: number, sog: number) => {
        const d = navDelta(22.005, 60.015, sog, T0 + t);
        d.updates[0]?.values.push({ path: "environment.depth.belowSurface" as never, value: 1.9 });
        f.send(d);
        clock.advance(T0 + t - clock.now());
      };
      at(1000, 3);
      at(2000, 3);
      at(3000, 0.4);
      type Note = { state: string; message: string } | undefined;
      const raised = lastValue(f.deltas, "notifications.grounding") as Note;
      plugin.stop();
      return { raised, stopped: lastValue(f.deltas, "notifications.grounding") as Note };
    };
    expect(run({})).toEqual({ raised: undefined, stopped: undefined });
    expect(run({ groundingDetector: { enabled: true } })).toEqual({
      raised: {
        state: "emergency",
        method: ["visual", "sound"],
        message: "Grounding detected: SOG fell from 3.0 to 0.4 m/s; depth 1.9 m against draft 1.8 m"
      },
      // Stopping the plugin clears the emergency it raised.
      stopped: { state: "normal", method: [], message: "UKC monitoring stopped" }
    });
  });

  test("with the living chart on, two passes over a shoal list a discrepancy and write a note", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const notes: string[] = [];
    (f.app as unknown as { resourcesApi: unknown }).resourcesApi = {
      setResource: (type: string, id: string) => {
        notes.push(`${type}/${id}`);
        return Promise.resolve();
      }
    };
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    expect(call("/v1/livechart/discrepancies").code).toBe(404);
    seedFixtureIndex(dataDir);
    plugin.start(
      {
        cellsDir: CELLS,
        boxRadiusKm: 0,
        leafZoom: 18,
        livechart: { enabled: true, writeNotes: true }
      },
      () => undefined
    );
    // The fairway is charted 10 m west of the swept area; the sounder reads 6 m there.
    const sounding = (t: number) => {
      const at = T0 + t;
      const d = navDelta(22.003, 60.0105, 0.3, at);
      d.updates[0]?.values.push(
        { path: "navigation.gnss.methodQuality" as never, value: "GNSS Fix" },
        { path: "navigation.gnss.horizontalDilution" as never, value: 0.8 }
      );
      f.send(d);
      f.send({
        updates: [
          {
            timestamp: new Date(at).toISOString() as never,
            values: [{ path: "environment.depth.belowSurface" as never, value: 6 }]
          }
        ]
      });
      clock.advance(at - clock.now());
    };
    for (const pass of [0, 20 * 60_000]) {
      for (let k = 1; k <= 3; k++) {
        sounding(pass + k * 1000);
      }
    }
    const list = call("/v1/livechart/discrepancies").body as {
      measured: number;
      charted: number;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.measured).toBeLessThan(list[0]?.charted as number);
    expect(notes[0]).toMatch(/^notes\/underkeel-shoal-/);
    // At 0.3 m/s, under 1 kn: the cell has all six soundings, the CSB log one per pass.
    expect(list[0]).toMatchObject({ samples: 6 });
    const csb = call("/v1/livechart/csb.geojson").body as { features: unknown[] };
    expect(csb.features).toHaveLength(2);
    plugin.stop();
    expect(fs.existsSync(path.join(dataDir, "livechart.json"))).toBe(true);
  });

  test("POST /v1/route-repair and /v1/departure-window answer for the same route body", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
    const plugin = underkeel(f.app, fakeClock(T0));
    const { router, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    const route = {
      type: "LineString",
      coordinates: [
        [22.004, 60.01],
        [22.03, 60.01]
      ]
    };
    const repair = await post("/v1/route-repair", { route });
    expect(repair.code).toBe(200);
    const repairs = (
      repair.body as { repairs: { index: number; reason?: string; legs: { status: string }[] }[] }
    ).repairs;
    expect(repairs.map((r) => r.index)).toEqual([0]);
    for (const r of repairs) {
      expect(r.reason !== undefined || r.legs.every((l) => l.status === "ok")).toBe(true);
    }
    const window = await post("/v1/departure-window", { route, horizon: 3600, step: 900 });
    expect(window.code).toBe(200);
    expect((window.body as { steps: unknown[] }).steps).toHaveLength(5);
    expect((window.body as { windows: unknown[] }).windows).toEqual([]);
    expect((await post("/v1/departure-window", { route, horizon: 1e9 })).code).toBe(400);
    // 865 departures over a 32 km route is more work than one request may take.
    const long = { type: "LineString", coordinates: [route.coordinates[0], [22.004, 60.3]] };
    const tooMuch = await post("/v1/departure-window", {
      route: long,
      horizon: 3 * 86_400,
      step: 300
    });
    expect(tooMuch.code).toBe(400);
    expect((tooMuch.body as { errors: string[] }).errors[0]).toMatch(/departures × corridor area/);
    // 200 legs of 5 m are short, but 193 departures still make 38 600 leg checks.
    const zigzag = {
      type: "LineString",
      coordinates: Array.from({ length: 201 }, (_, i) => [22.004 + (i % 2) * 0.0001, 60.01])
    };
    const manyLegs = await post("/v1/departure-window", { route: zigzag });
    expect(manyLegs.code).toBe(400);
    expect((manyLegs.body as { errors: string[] }).errors[0]).toMatch(/departures × legs/);
    // The first departure is at the start of the horizon: 1000 steps are 1001 departures.
    const count = (horizon: number) =>
      post("/v1/departure-window", { route, horizon, step: 300 }).then((r) => r.code);
    expect(await count(999 * 300)).toBe(200);
    expect(await count(1000 * 300)).toBe(400);
    plugin.stop();
  });

  test("POST /v1/route-check answers with per-leg results", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
    const plugin = underkeel(f.app, fakeClock(T0));
    const { router, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const before = await post("/v1/route-check", { route: { type: "LineString" } });
    expect(before.code).toBe(400);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    const r = await post("/v1/route-check", {
      route: {
        type: "LineString",
        coordinates: [
          [22.004, 60.01],
          [22.03, 60.01]
        ]
      }
    });
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ legs: [{ index: 0, status: "fail" }] });
    plugin.stop();
  });

  test("POST /v1/query and the UKC tiles answer for the current vessel", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
    const plugin = underkeel(f.app, fakeClock(T0));
    const { router, call, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const tile = (z: string, x: string, file: string) =>
      call("/v1/tiles/ukc/:z/:x/:file", {}, { z, x, file });
    expect((await post("/v1/query", { geometry: { type: "Point", coordinates: ROCK } })).code).toBe(
      503
    );
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);

    const rock = await post("/v1/query", { geometry: { type: "Point", coordinates: ROCK } });
    expect(rock.code).toBe(200);
    expect(rock.body).toMatchObject({ class: "danger", hazard: { lnam: "0226000003F10001" } });
    const shallow = await post("/v1/query", {
      geometry: { type: "Point", coordinates: ROCK },
      draft: 1.5
    });
    expect(shallow.body).toMatchObject({ explanation: { draft: 1.5 } });
    expect((await post("/v1/query", { geometry: { type: "Line" } })).code).toBe(400);

    const [mx, my] = toMercator(ROCK[0], ROCK[1]);
    const t = tileAt(16, mx, my);
    const ok = tile("16", String(t.x), `${t.y}.pbf`);
    expect(ok.code).toBe(200);
    expect(ok.type).toBe("application/vnd.mapbox-vector-tile");
    const classes = decodeMvt(ok.body as Uint8Array)[0]?.features.map((ft) => ft.properties.class);
    expect(classes).toContain("danger");
    expect(tile("16", String(t.x), `${t.y}.png`).code).toBe(400);
    expect(tile("16", String(2 ** 16), "0.pbf").code).toBe(400);
    expect(decodeMvt(tile("8", "0", "0.pbf").body as Uint8Array)[0]?.features).toEqual([]);
    const head = call("/v1/tiles/ukc/changes").body as { epoch: string; rev: number };
    expect(head).toMatchObject({ all: false, tiles: [] });
    expect(
      call("/v1/tiles/ukc/changes", { epoch: head.epoch, rev: String(head.rev) }).body
    ).toMatchObject({ all: false, tiles: [] });

    const style = call("/v1/ukc-style.json").body as { sources: { ukc: { tiles: string[] } } };
    expect(style.sources.ukc.tiles).toEqual([
      "/plugins/signalk-underkeel/v1/tiles/ukc/{z}/{x}/{y}.pbf"
    ]);
    plugin.stop();
  });

  test("POST /v1/query takes the FMI level only where the forecast reaches", async () => {
    // An hourly forecast 30 cm above mean water from an hour before T0, for 48 h.
    const members = Array.from({ length: 50 }, (_, i) => {
      const t = new Date(T0 + (i - 1) * 3600 * 1000).toISOString().replace(".000", "");
      return `<wfs:member><BsWfs:BsWfsElement gml:id="e${i}"><BsWfs:Time>${t}</BsWfs:Time>
        <BsWfs:ParameterName>SeaLevel</BsWfs:ParameterName>
        <BsWfs:ParameterValue>30</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>`;
    });
    const xml = `<wfs:FeatureCollection>${members.join("")}</wfs:FeatureCollection>`;
    const fetch = (url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(url.includes("forecast") ? xml : "")
      });
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock, fetch);
    const { router, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start(
      { cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18, waterLevel: { source: "fmi" } },
      () => undefined
    );
    f.send(navDelta(ROCK[0], ROCK[1], 0, clock.now()));
    clock.advance(1000);
    for (let i = 0; i < 20; i++) {
      await settle();
    }
    const at = async (lon: number) =>
      (await post("/v1/query", { geometry: { type: "Point", coordinates: [lon, ROCK[1]] } }))
        .body as { waterLevelDegraded?: string; explanation?: { waterLevelSource: string } };
    const near = await at(ROCK[0]);
    expect(near.explanation?.waterLevelSource).toMatch(/^fmi/);
    expect(near.waterLevelDegraded).toBeUndefined();
    // 60 km east: the forecast fetched at the vessel does not hold there.
    const far = await at(ROCK[0] + 60000 / M_PER_DEG_LON);
    expect(far.waterLevelDegraded).toMatch(/fmi/);
    plugin.stop();
  });

  test("a UKC tile takes the FMI level only where the forecast reaches", async () => {
    // An hourly forecast 30 cm above mean water from an hour before T0, for 48 h.
    const members = Array.from({ length: 50 }, (_, i) => {
      const t = new Date(T0 + (i - 1) * 3600 * 1000).toISOString().replace(".000", "");
      return `<wfs:member><BsWfs:BsWfsElement gml:id="e${i}"><BsWfs:Time>${t}</BsWfs:Time>
        <BsWfs:ParameterName>SeaLevel</BsWfs:ParameterName>
        <BsWfs:ParameterValue>30</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>`;
    });
    const xml = `<wfs:FeatureCollection>${members.join("")}</wfs:FeatureCollection>`;
    const fetch = (url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(url.includes("forecast") ? xml : "")
      });
    const [mx, my] = toMercator(ROCK[0], ROCK[1]);
    const t = tileAt(14, mx, my);
    /** The ROCK z14 tile's classes with the vessel, and so the forecast fetch, at `lon`. */
    const classesWithVesselAt = async (lon: number) => {
      const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
      const clock = fakeClock(T0);
      const plugin = underkeel(f.app, clock, fetch);
      const { router, call } = fakeRouter();
      plugin.registerWithRouter?.(router as never);
      seedFixtureIndex(dataDir);
      plugin.start(
        { cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18, waterLevel: { source: "fmi" } },
        () => undefined
      );
      f.send(navDelta(lon, ROCK[1], 0, clock.now()));
      clock.advance(1000);
      for (let i = 0; i < 20; i++) {
        await settle();
      }
      const tile = call(
        "/v1/tiles/ukc/:z/:x/:file",
        {},
        { z: "14", x: String(t.x), file: `${t.y}.pbf` }
      );
      plugin.stop();
      expect(tile.code).toBe(200);
      return decodeMvt(tile.body as Uint8Array)[0]?.features.map((ft) => ft.properties.class);
    };
    expect(await classesWithVesselAt(ROCK[0])).toContain("clear");
    // 60 km east: the forecast fetched there does not hold at ROCK.
    expect(await classesWithVesselAt(ROCK[0] + 60000 / M_PER_DEG_LON)).not.toContain("clear");
  });

  test("registers the plotterExtensions manifest", async () => {
    const f = fakeApp(dataDir);
    const plugin = underkeel(f.app, fakeClock(T0));
    plugin.start({}, () => undefined);
    const provider = f.providers[0] as {
      type: string;
      methods: {
        listResources: () => Promise<unknown>;
        getResource: (id: string) => Promise<unknown>;
        setResource: () => Promise<void>;
      };
    };
    expect(provider.type).toBe("plotterExtensions");
    const list = (await provider.methods.listResources()) as Record<string, unknown>;
    expect(Object.keys(list)).toEqual(["signalk-underkeel"]);
    await expect(provider.methods.getResource("signalk-underkeel")).resolves.toMatchObject({
      name: "Under-Keel Awareness"
    });
    await expect(provider.methods.getResource("nope")).rejects.toThrow(/no plotterExtensions/);
    await expect(provider.methods.setResource()).rejects.toThrow(/read-only/);
    plugin.stop();
  });

  test("timestamps from the future are replaced by receipt time", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    f.send(navDelta(22.003, 60.01, 3, T0 + 3_600_000));
    clock.advance(11_000);
    // Receipt time T0 is 11 s old by now: stale, not trusted for an hour.
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("unknown");
    plugin.stop();
  });

  test("stopping during an alarm clears clearance and time to shoal", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    f.send(navDelta(ROCK[0] - 75 / M_PER_DEG_LON, ROCK[1], 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.timeToShoal")).toEqual(expect.any(Number));
    plugin.stop();
    expect(lastValue(f.deltas, "navigation.underKeel.clearance")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.timeToShoal")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.clearanceSigma")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.risk")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.escapeHeading")).toBeNull();
  });

  test("a non-finite or out-of-range position clears the sample", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    for (const bad of [navDelta(NaN, 60.01, 3, T0), navDelta(22.003, 91, 3, T0)]) {
      f.send(navDelta(22.003, 60.01, 3, T0));
      f.send(bad);
      clock.advance(1000);
      expect(call("/v1/status").body).toMatchObject({
        engine: { state: "unknown", reason: "no position" }
      });
    }
    plugin.stop();
  });

  test("a null position (source timed out) clears the sample", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    f.send(navDelta(22.003, 60.01, 3, T0));
    f.send({
      updates: [{ values: [{ path: "navigation.position" as never, value: null }] }]
    });
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("unknown");
    plugin.stop();
  });
  test("a null from one $source leaves another source's good position in place", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
    const nullFrom = (source: string) => ({
      updates: [
        {
          $source: source as never,
          timestamp: new Date(clock.now() + 500).toISOString() as never,
          values: [{ path: "navigation.position" as never, value: null }]
        }
      ]
    });
    const states: unknown[] = [];
    for (let k = 0; k < 4; k++) {
      const d = navDelta(ROCK[0] - 300 / M_PER_DEG_LON, ROCK[1], 3, clock.now());
      (d.updates[0] as { $source?: string }).$source = "gps.A";
      f.send(d);
      // A second receiver without a fix publishes a null position.
      f.send(nullFrom("gps.B"));
      clock.advance(1000);
      states.push(lastValue(f.deltas, "navigation.underKeel.state"));
    }
    expect(states).toEqual(["warn", "warn", "warn", "warn"]);
    // The source that gave the position can still clear it.
    f.send(nullFrom("gps.A"));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("unknown");
    plugin.stop();
  });
});

describe("index loader", () => {
  test("reports a missing cells directory as a reason", async () => {
    const r = await loadOrBuildIndex(
      parseConfig({ cellsDir: "/nonexistent/cells", boxRadiusKm: 0 }),
      os.tmpdir()
    );
    expect(r.index).toBeUndefined();
    expect(r.reason).toMatch(/chart index failed/);
  });

  test("an empty cells directory is reported", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-empty-"));
    try {
      const cfg = parseConfig({ cellsDir: dir, boxRadiusKm: 0, indexDir: path.join(dir, "ix") });
      expect((await loadOrBuildIndex(cfg, dir)).reason).toMatch(/no cells/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads a saved index without rebuilding", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-load-"));
    try {
      const cfg = parseConfig({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 16 });
      expect((await loadOrBuildIndex(cfg, dir)).built).toBe(true);
      const again = await loadOrBuildIndex(cfg, dir);
      expect(again.built).toBe(false);
      expect(again.index?.catalogue.cells).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rebuilds a saved index of an older pyramid version", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-old-"));
    try {
      const cfg = parseConfig({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 16 });
      expect((await loadOrBuildIndex(cfg, dir)).built).toBe(true);
      const file = path.join(dir, "index", "pyramid.bin");
      const buf = fs.readFileSync(file);
      const nl = buf.indexOf(0x0a);
      const header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as { version: number };
      const old = Buffer.from(JSON.stringify({ ...header, version: PYRAMID_VERSION - 1 }), "utf8");
      fs.writeFileSync(file, Buffer.concat([old, buf.subarray(nl)]));
      const again = await loadOrBuildIndex(cfg, dir);
      expect(again.built).toBe(true);
      expect(again.index?.catalogue.cells).toHaveLength(2);
      expect((await loadOrBuildIndex(cfg, dir)).built).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rebuilds a saved index whose hazards are in hazards.json, and replaces it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-old-"));
    try {
      const cfg = parseConfig({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 16 });
      const built = await loadOrBuildIndex(cfg, dir);
      const index = path.join(dir, "index");
      const json = (built.index?.hazards.features() ?? []).map((f) => ({
        ...f,
        depth: Number.isFinite(f.depth) ? f.depth : null
      }));
      fs.rmSync(path.join(index, "hazards.bin"));
      fs.writeFileSync(path.join(index, "hazards.json"), JSON.stringify(json));
      const again = await loadOrBuildIndex(cfg, dir);
      expect(again.built).toBe(true);
      expect(again.index?.hazards.size).toBe(json.length);
      expect(fs.readdirSync(index).sort()).toEqual(["cells.json", "hazards.bin", "pyramid.bin"]);
      expect((await loadOrBuildIndex(cfg, dir)).built).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manifest and step", () => {
  test("the manifest declares only the services this build serves", () => {
    const m = buildManifest("9.9.9")["signalk-underkeel"];
    expect(m?.version).toBe("9.9.9");
    expect(m?.services.navigationSafety).toEqual({
      apiVersion: "1",
      base: "/plugins/signalk-underkeel/v1",
      provides: ["lookahead", "routeCheck", "routeRepair", "departureWindow", "query", "acks"],
      statePath: "navigation.underKeel",
      notificationPath: "notifications.navigation.underKeel"
    });
    // Nothing is required, so a host without any of these still offers the overlays it can draw.
    expect(m?.requires).toEqual([]);
    expect(m?.optional).toEqual(
      expect.arrayContaining(["overlays.data", "background.iframe", "routes", "signalk.stream"])
    );
    expect(m?.overlays.map((o) => [o.id, o.style])).toEqual([
      ["ukc", "/plugins/signalk-underkeel/v1/ukc-style.json"],
      ["lookahead", "/plotterext/signalk-underkeel/lookahead-style.json"],
      ["routecheck", "/plotterext/signalk-underkeel/routecheck-style.json"]
    ]);
    expect(m?.background.map((b) => b.url)).toEqual(["/plotterext/signalk-underkeel/runtime.html"]);
    expect(m?.buttons[0]?.action).toEqual({ type: "togglePanel", panel: "details" });
  });

  test("a fast boat's footprints sweep hulls close enough to touch with no buffer", () => {
    const vessel = { draft: 1, length: 12, beam: 4 };
    expect(sweepFor(3, vessel, DEFAULT_LOOKAHEAD)).toBe(3);
    const fast = sweepFor(20, vessel, DEFAULT_LOOKAHEAD);
    expect(fast * 20).toBeLessThanOrEqual(12);
    expect(sweepFor(0, vessel, DEFAULT_LOOKAHEAD)).toBe(3);
  });
});
