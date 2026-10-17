import fs from "fs";
import os from "os";
import path from "path";
import type { Delta, ServerAPI } from "@signalk/server-api";
import { buildManifest } from "../src/api/manifest";
import type { Clock } from "../src/monitor";
import { loadOrBuildIndex } from "../src/index-loader";
import { parseConfig } from "../src/config";
import { stepFor, DEFAULT_LOOKAHEAD } from "../src/engine/lookahead";
import underkeel = require("../src/index");
import { FIXTURES, M_PER_DEG_LON, ROCK } from "./helpers/fixture-index";

interface FakeRes {
  json: (body: unknown) => void;
  status: (code: number) => FakeRes & { end: () => void };
}

type Handler = (req: { query?: Record<string, string>; body?: unknown }, res: FakeRes) => void;

interface FakeClock extends Clock {
  advance(ms: number): void;
}

function fakeClock(start: number): FakeClock {
  let now = start;
  let fn: (() => void) | undefined;
  return {
    now: () => now,
    setInterval: (f) => {
      fn = f;
      return 1;
    },
    clearInterval: () => {
      fn = undefined;
    },
    advance(ms: number) {
      now += ms;
      fn?.();
    }
  };
}

function fakeApp(dataDir: string, self: Record<string, unknown> = {}) {
  const deltas: Partial<Delta>[] = [];
  const errors: string[] = [];
  const providers: unknown[] = [];
  let onDelta: ((d: Delta) => void) | undefined;
  let unsubscribed = 0;
  const app = {
    handleMessage: (_id: string, msg: Partial<Delta>) => deltas.push(msg),
    setPluginStatus: () => undefined,
    setPluginError: (msg: string) => errors.push(msg),
    error: (msg: string) => errors.push(msg),
    getDataDirPath: () => dataDir,
    getSelfPath: (p: string) => self[p],
    registerResourceProvider: (p: unknown) => providers.push(p),
    subscriptionmanager: {
      subscribe: (
        _cmd: unknown,
        unsubscribes: (() => void)[],
        _err: unknown,
        cb: (d: Delta) => void
      ) => {
        onDelta = cb;
        unsubscribes.push(() => unsubscribed++);
      }
    }
  } as unknown as ServerAPI;
  return {
    app,
    deltas,
    errors,
    providers,
    send: (d: Delta) => onDelta?.(d),
    unsubscribed: () => unsubscribed
  };
}

function fakeRouter(withAccess = true) {
  const routes = new Map<string, Handler>();
  const levels = new Map<string, string>();
  const add = (method: string) => (p: string, h: Handler) => routes.set(`${method} ${p}`, h);
  const plain = { get: add("GET"), post: add("POST") };
  const scoped = (level: string) => {
    const reg = (method: string) => (p: string, h: Handler) => {
      levels.set(`${method} ${p}`, level);
      return add(method)(p, h);
    };
    return { get: reg("GET"), post: reg("POST") };
  };
  const router = withAccess ? { ...plain, access: scoped } : plain;
  const call = (p: string, query: Record<string, string> = {}) => {
    let body: unknown;
    let code = 200;
    const res: FakeRes = {
      json: (b) => (body = b),
      status: (c) => {
        code = c;
        return { ...res, end: () => undefined };
      }
    };
    routes.get(`GET ${p}`)?.({ query }, res);
    return { code, body };
  };
  const post = (p: string, reqBody: unknown) =>
    new Promise<{ code: number; body: unknown }>((resolve) => {
      let code = 200;
      const res: FakeRes = {
        json: (b) => resolve({ code, body: b }),
        status: (c) => {
          code = c;
          return { ...res, end: () => resolve({ code, body: undefined }) };
        }
      };
      routes.get(`POST ${p}`)?.({ body: reqBody }, res);
    });
  return { router, call, post, levels };
}

function values(deltas: Partial<Delta>[]) {
  return deltas.flatMap((d) => (d.updates ?? []).flatMap((u) => ("values" in u ? u.values : [])));
}

function lastValue(deltas: Partial<Delta>[], p: string): unknown {
  return values(deltas)
    .filter((v) => v.path === p)
    .pop()?.value;
}

function notificationCount(deltas: Partial<Delta>[]): number {
  return values(deltas).filter((v) => v.path === "notifications.navigation.underKeel").length;
}

const T0 = Date.parse("2026-10-17T12:00:00Z");

function navDelta(lon: number, lat: number, sog: number, at: number): Delta {
  return {
    updates: [
      {
        timestamp: new Date(at).toISOString() as never,
        values: [
          { path: "navigation.position" as never, value: { latitude: lat, longitude: lon } },
          { path: "navigation.courseOverGroundTrue" as never, value: Math.PI / 2 },
          { path: "navigation.speedOverGround" as never, value: sog },
          { path: "navigation.headingTrue" as never, value: Math.PI / 2 }
        ]
      }
    ]
  };
}

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
      "POST /v1/route-check": "readonly"
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

  test("builds the index, follows the vessel and raises the look-ahead notification", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);

    expect(fs.existsSync(path.join(dataDir, "index", "pyramid.bin"))).toBe(true);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("unknown");

    // 75 m west of the rock at 3 m/s: the rock is ~25 s ahead.
    const lon = ROCK[0] - 75 / M_PER_DEG_LON;
    f.send(navDelta(lon, ROCK[1], 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("alarm");
    expect(lastValue(f.deltas, "navigation.underKeel.waterLevel")).toBe(0);
    const n = lastValue(f.deltas, "notifications.navigation.underKeel") as {
      state: string;
      message: string;
    };
    expect(n.state).toBe("alarm");
    expect(n.message).toMatch(/UWTROC FI5-ROCK/);
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

  test("POST /v1/route-check answers with per-leg results", async () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
    const plugin = underkeel(f.app, fakeClock(T0));
    const { router, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const before = await post("/v1/route-check", { route: { type: "LineString" } });
    expect(before.code).toBe(400);
    plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
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
    plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
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
    plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
    f.send(navDelta(ROCK[0] - 75 / M_PER_DEG_LON, ROCK[1], 3, T0));
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.timeToShoal")).toEqual(expect.any(Number));
    plugin.stop();
    expect(lastValue(f.deltas, "navigation.underKeel.clearance")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.timeToShoal")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.clearanceSigma")).toBeNull();
    expect(lastValue(f.deltas, "navigation.underKeel.risk")).toBeNull();
  });

  test("a non-finite or out-of-range position clears the sample", () => {
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 1.5 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
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
    plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
    f.send(navDelta(22.003, 60.01, 3, T0));
    f.send({
      updates: [{ values: [{ path: "navigation.position" as never, value: null }] }]
    });
    clock.advance(1000);
    expect(lastValue(f.deltas, "navigation.underKeel.state")).toBe("unknown");
    plugin.stop();
  });
});

describe("index loader", () => {
  test("reports a missing cells directory as a reason", () => {
    const r = loadOrBuildIndex(parseConfig({ cellsDir: "/nonexistent/cells" }), os.tmpdir());
    expect(r.index).toBeUndefined();
    expect(r.reason).toMatch(/chart index failed/);
  });

  test("an empty cells directory is reported", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-empty-"));
    try {
      const cfg = parseConfig({ cellsDir: dir, indexDir: path.join(dir, "ix") });
      expect(loadOrBuildIndex(cfg, dir).reason).toMatch(/no cells/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads a saved index without rebuilding", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-load-"));
    try {
      const cfg = parseConfig({ cellsDir: FIXTURES, leafZoom: 16 });
      expect(loadOrBuildIndex(cfg, dir).built).toBe(true);
      const again = loadOrBuildIndex(cfg, dir);
      expect(again.built).toBe(false);
      expect(again.index?.catalogue.cells).toHaveLength(2);
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
      provides: ["lookahead", "routeCheck"],
      statePath: "navigation.underKeel",
      notificationPath: "notifications.navigation.underKeel"
    });
  });

  test("a fast boat gets a shorter step so footprints still overlap", () => {
    const vessel = { draft: 1, length: 12, beam: 4 };
    expect(stepFor(3, vessel, DEFAULT_LOOKAHEAD)).toBe(3);
    const fast = stepFor(20, vessel, DEFAULT_LOOKAHEAD);
    expect(fast * 20).toBeLessThanOrEqual(12 + 2 * DEFAULT_LOOKAHEAD.positionBuffer);
    expect(stepFor(0, vessel, DEFAULT_LOOKAHEAD)).toBe(3);
  });
});
