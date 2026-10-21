import fs from "fs";
import os from "os";
import path from "path";
import type { ApiProvider, ApiReply } from "../../src/api/routes";
import { registerRoutes } from "../../src/api/routes";
import { parseConfig } from "../../src/config";
import * as routeCheckModule from "../../src/engine/route-check";
import type { RouteServiceDeps } from "../../src/route-service";
import { departureWindowReply, MAX_WAITING, RequestQueue } from "../../src/route-service";
import underkeel = require("../../src/index");
import { FIXTURES, fixtureIndex, seedFixtureIndex } from "../helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, T0 } from "../helpers/plugin-harness";

/** Admission control and cancellation of the heavy REST work. */

const OK: ApiReply = { status: 200, body: {} };

/** A job that runs until `release` is called, counting how many run at once. */
function gated(counter: { now: number; max: number }) {
  let release = () => undefined as void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const job = async () => {
    counter.now += 1;
    counter.max = Math.max(counter.max, counter.now);
    await done;
    counter.now -= 1;
    return OK;
  };
  return { job, release: () => release() };
}

const never = () => new AbortController().signal;

describe("request queue", () => {
  test("one job runs at a time, four wait, and the next is refused with 503", async () => {
    const queue = new RequestQueue();
    const counter = { now: 0, max: 0 };
    const jobs = Array.from({ length: MAX_WAITING + 1 }, () => gated(counter));
    const replies = jobs.map((j) => queue.run(never(), j.job));
    const refused = await queue.run(never(), () => Promise.resolve(OK));
    expect(refused).toEqual({
      status: 503,
      body: { errors: ["busy: 4 requests are waiting; try again shortly"] },
      headers: { "Retry-After": "2" }
    });
    jobs.forEach((j) => j.release());
    expect(await Promise.all(replies)).toEqual(jobs.map(() => OK));
    expect(counter.max).toBe(1);
    // With the line empty again, a new job runs.
    expect(await queue.run(never(), () => Promise.resolve(OK))).toEqual(OK);
  });

  test("a waiting job whose client goes away never runs and frees its place", async () => {
    const queue = new RequestQueue();
    const counter = { now: 0, max: 0 };
    const first = gated(counter);
    const running = queue.run(never(), first.job);
    const client = new AbortController();
    const job = jest.fn(() => Promise.resolve(OK));
    const waiting = queue.run(client.signal, job);
    client.abort(new Error("client disconnected"));
    expect(await waiting).toEqual({ status: 503, body: { errors: ["client disconnected"] } });
    first.release();
    await running;
    expect(job).not.toHaveBeenCalled();
    expect(counter.max).toBe(1);
  });

  test("an aborted departure window stops checking legs and answers with the reason", async () => {
    const deps: RouteServiceDeps = {
      index: fixtureIndex(),
      indexReason: undefined,
      config: parseConfig({}),
      vessel: () => ({ draft: 1.2, length: 12, beam: 4 }),
      waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
      waveHeight: () => undefined,
      getRoute: () => Promise.reject(new Error("unused")),
      now: () => Date.parse("2026-10-18T07:00:00Z"),
      queue: new RequestQueue()
    };
    const client = new AbortController();
    const checkLeg = routeCheckModule.checkLeg;
    const calls = jest.spyOn(routeCheckModule, "checkLeg").mockImplementation((...args) => {
      client.abort(new Error("client disconnected"));
      return checkLeg(...args);
    });
    const route = {
      type: "LineString",
      coordinates: [
        [22.004, 60.01],
        [22.03, 60.01],
        [22.004, 60.012]
      ]
    };
    const reply = await departureWindowReply({ route, horizon: 86_400 }, deps, client.signal);
    const checked = calls.mock.calls.length;
    calls.mockRestore();
    expect(reply).toEqual({ status: 503, body: { errors: ["client disconnected"] } });
    expect(checked).toBe(1);
  });
});

describe("REST cancellation", () => {
  test("a client that goes away aborts its request's signal", async () => {
    let seen: AbortSignal | undefined;
    const pending = (_body: unknown, signal: AbortSignal) => {
      seen = signal;
      return new Promise<ApiReply>((resolve) =>
        signal.addEventListener("abort", () => resolve({ status: 503, body: { errors: [] } }))
      );
    };
    const api = { routeCheck: pending } as unknown as ApiProvider;
    const { router, open } = fakeRouter();
    registerRoutes(router as never, api);
    const request = open("/v1/route-check", {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen?.aborted).toBe(false);
    request.close();
    expect(seen?.aborted).toBe(true);
    expect((await request.reply).code).toBe(503);
  });

  test("a refused request carries Retry-After", async () => {
    const api = {
      query: () =>
        Promise.resolve({
          status: 503,
          body: { errors: ["busy"] },
          headers: { "Retry-After": "2" }
        })
    } as unknown as ApiProvider;
    const { router, open } = fakeRouter();
    registerRoutes(router as never, api);
    const reply = await open("/v1/query", {}).reply;
    expect(reply).toEqual({
      code: 503,
      body: { errors: ["busy"] },
      headers: { "retry-after": "2" }
    });
  });

  test("stopping the plugin aborts a running departure window", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-queue-"));
    try {
      const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
      const plugin = underkeel(f.app, fakeClock(T0));
      const { router, open } = fakeRouter();
      plugin.registerWithRouter?.(router as never);
      seedFixtureIndex(dataDir);
      plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
      const started = new Promise<void>((resolve) => {
        const checkLeg = routeCheckModule.checkLeg;
        jest.spyOn(routeCheckModule, "checkLeg").mockImplementation((...args) => {
          resolve();
          return checkLeg(...args);
        });
      });
      const route = {
        type: "LineString",
        coordinates: [
          [22.004, 60.01],
          [22.03, 60.01]
        ]
      };
      const request = open("/v1/departure-window", { route, horizon: 86_400, step: 300 });
      await started;
      plugin.stop();
      expect((await request.reply).body).toEqual({ errors: ["plugin stopped"] });
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
