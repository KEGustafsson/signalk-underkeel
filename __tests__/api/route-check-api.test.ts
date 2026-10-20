import { EventEmitter } from "events";
import type { Request } from "express";
import {
  LIMITS,
  parseRouteRequest,
  routeResourceCoordinates,
  speedsFor
} from "../../src/api/route-request";
import { MAX_BODY_BYTES, readJsonBody } from "../../src/api/routes";
import { parseConfig } from "../../src/config";
import type { RouteServiceDeps } from "../../src/route-service";
import {
  departureWindowReply,
  RequestQueue,
  routeCheck,
  routeRepair
} from "../../src/route-service";
import { fixtureIndex } from "../helpers/fixture-index";

const LINE = {
  type: "LineString",
  coordinates: [
    [22.004, 60.01],
    [22.03, 60.01]
  ]
};

describe("route-check request validation", () => {
  test("accepts inline geometry with options", () => {
    const r = parseRouteRequest(
      {
        route: LINE,
        departure: "2026-10-18T07:00:00Z",
        speed: { default: 3.1 },
        xteLimit: 25,
        vessel: { draft: 1.9 }
      },
      Date.parse("2026-10-18T06:00:00Z")
    );
    expect(r).toEqual({
      ok: true,
      value: {
        coordinates: LINE.coordinates,
        departure: Date.parse("2026-10-18T07:00:00Z"),
        speed: 3.1,
        xteLimit: 25,
        draft: 1.9
      }
    });
  });

  test("accepts a route reference and per-leg speeds", () => {
    expect(
      parseRouteRequest({ routeRef: "/resources/routes/abc-123", speed: { legs: [2, 3] } })
    ).toEqual({ ok: true, value: { routeId: "abc-123", speed: [2, 3] } });
    expect(parseRouteRequest({ route: LINE, speed: [2] })).toMatchObject({ ok: true });
  });

  test.each([
    [{}, /give route/],
    [null, /give route/],
    [{ routeRef: "/resources/routes/../../etc" }, /give route/],
    [{ route: { type: "Point" } }, /LineString/],
    [{ route: { type: "LineString", coordinates: [[22, 60]] } }, /2\.\.1000 points/],
    [
      {
        route: {
          type: "LineString",
          coordinates: [
            [22, 60],
            [200, 60]
          ]
        }
      },
      /within/
    ],
    [{ route: { type: "LineString", coordinates: [[22, 60], "x"] } }, /within/],
    [{ route: LINE, speed: 0 }, /speed/],
    [{ route: LINE, speed: [2, 99] }, /speed/],
    [{ route: LINE, speed: null }, /speed must be/],
    [{ route: LINE, departure: "tomorrow" }, /ISO 8601/],
    [{ route: LINE, xteLimit: -1 }, /xteLimit/],
    [{ route: LINE, vessel: { draft: 100 } }, /draft/],
    [{ route: LINE, vessel: { draft: 0 } }, /vessel\.draft must be 0\.01\.\.30 m/],
    [{ route: LINE, probability: 0.9 }, /probability/]
  ])("rejects %j", (body, message) => {
    const r = parseRouteRequest(body);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.join("; ")).toMatch(message);
  });

  test("a route longer than the limit is refused, also by reference", () => {
    // 0.1° of longitude at 60°N is about 5.6 km; 100 legs is about 560 km.
    const coordinates = Array.from({ length: 101 }, (_, i) => [20 + i * 0.1, 60]);
    const r = parseRouteRequest({ route: { type: "LineString", coordinates } });
    expect(r.ok ? "" : r.errors.join("; ")).toMatch(/at most 500 km/);
    const ok = coordinates.slice(0, 80);
    expect(parseRouteRequest({ route: { type: "LineString", coordinates: ok } }).ok).toBe(true);
    const geometry = { type: "LineString", coordinates };
    expect(routeResourceCoordinates({ feature: { geometry } })).toBeUndefined();
  });

  test("a departure more than a year from now is refused with a reason", async () => {
    const now = Date.parse("2026-10-18T07:00:00Z");
    for (const departure of [
      "+275760-09-13T00:00:00.000Z",
      "2028-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z"
    ]) {
      const r = parseRouteRequest({ route: LINE, departure }, now);
      expect(r.ok ? "" : r.errors.join("; ")).toBe("departure must be within a year of now");
    }
    expect(parseRouteRequest({ route: LINE, departure: "2027-04-01T00:00:00Z" }, now).ok).toBe(
      true
    );
    const far = await routeCheck({ route: LINE, departure: "+275760-09-13T00:00:00.000Z" }, deps());
    expect(far).toEqual({
      status: 400,
      body: { errors: ["departure must be within a year of now"] }
    });
  });

  test("too many points are refused", () => {
    const coordinates = Array.from({ length: LIMITS.maxPoints + 1 }, (_, i) => [22 + i * 1e-4, 60]);
    expect(parseRouteRequest({ route: { type: "LineString", coordinates } }).ok).toBe(false);
  });

  test("speeds per leg", () => {
    expect(speedsFor(2, 3)).toEqual([2, 2, 2]);
    expect(speedsFor([1, 2], 2)).toEqual([1, 2]);
    expect(speedsFor([1, 2], 3)).toMatch(/2 values for 3 legs/);
  });

  test("route resources", () => {
    expect(routeResourceCoordinates({ feature: { geometry: LINE } })).toEqual(LINE.coordinates);
    expect(routeResourceCoordinates({})).toBeUndefined();
    expect(routeResourceCoordinates(undefined)).toBeUndefined();
  });
});

function deps(over: Partial<RouteServiceDeps> = {}): RouteServiceDeps {
  return {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({}),
    vessel: () => ({ draft: 3.6, length: 12, beam: 4 }),
    waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    waveHeight: () => undefined,
    getRoute: (id) =>
      id === "known"
        ? Promise.resolve({ feature: { geometry: LINE } })
        : Promise.reject(new Error("nope")),
    now: () => Date.parse("2026-10-18T07:00:00Z"),
    queue: new RequestQueue(),
    ...over
  };
}

describe("a plugin stop while a request still prepares", () => {
  test.each([
    ["route check", routeCheck],
    ["route repair", routeRepair],
    ["departure window", departureWindowReply]
  ] as const)("aborts the %s fetched by reference", async (_name, handler) => {
    let release = (): void => undefined;
    const queue = new RequestQueue();
    const d = deps({
      queue,
      getRoute: () =>
        new Promise((resolve) => {
          release = () => resolve({ feature: { geometry: LINE } });
        })
    });
    const reply = handler({ routeRef: "/resources/routes/known", horizon: 3600, step: 600 }, d);
    await new Promise((resolve) => setImmediate(resolve));
    queue.abortAll("plugin stopped");
    release();
    expect((await reply).body).toEqual({ errors: ["plugin stopped"] });
  });
});

describe("route-check service", () => {
  test("checks inline geometry with the current vessel", async () => {
    const r = await routeCheck({ route: LINE }, deps());
    expect(r.status).toBe(200);
    expect((r.body as { legs: { status: string }[] }).legs[0]?.status).toBe("fail");
  });

  test("a draft override replaces the vessel's draft", async () => {
    const r = await routeCheck({ route: LINE, vessel: { draft: 1.2 } }, deps());
    expect((r.body as { legs: { status: string }[] }).legs[0]?.status).toBe("ok");
    const none = await routeCheck(
      { route: LINE, vessel: { draft: 1.2 } },
      deps({ vessel: () => undefined })
    );
    expect(none.status).toBe(200);
  });

  test("a corridor too wide for the route's length is refused before any work", async () => {
    // About 61 km at ±2010 m is 245 km² of corridor; at the default ±40 m it is 5 km².
    const long = {
      type: "LineString",
      coordinates: [
        [22.004, 60.01],
        [22.004, 60.56]
      ]
    };
    const wide = await routeCheck({ route: long, xteLimit: 2000 }, deps());
    expect(wide.status).toBe(400);
    expect((wide.body as { errors: string[] }).errors[0]).toMatch(
      /route length × corridor width must be at most 200 km²/
    );
    expect((await routeCheck({ route: long }, deps())).status).toBe(200);
  });

  test("other work runs between the corridor queries of a check", async () => {
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    const r = await routeCheck({ route: LINE }, deps());
    expect(r.status).toBe(200);
    expect(ran).toBe(true);
  });

  test("resolves a route reference", async () => {
    expect((await routeCheck({ routeRef: "/resources/routes/known" }, deps())).status).toBe(200);
    expect((await routeCheck({ routeRef: "/resources/routes/missing" }, deps())).status).toBe(404);
  });

  test("errors carry a status and never a partial result", async () => {
    expect((await routeCheck({}, deps())).status).toBe(400);
    expect(
      (await routeCheck({ route: LINE }, deps({ index: undefined, indexReason: "no index" }))).body
    ).toEqual({ errors: ["no index"] });
    expect((await routeCheck({ route: LINE }, deps({ vessel: () => undefined }))).status).toBe(422);
    expect((await routeCheck({ route: LINE, speed: [1, 2] }, deps())).status).toBe(400);
  });
});

function streamRequest(chunks: string[], body?: unknown): Request {
  const req = new EventEmitter() as EventEmitter & { body?: unknown; destroy: () => void };
  req.body = body;
  req.destroy = () => undefined;
  setImmediate(() => {
    for (const c of chunks) {
      req.emit("data", Buffer.from(c));
    }
    req.emit("end");
  });
  return req as unknown as Request;
}

describe("JSON body", () => {
  test("uses a parsed body when the server already parsed it", async () => {
    await expect(readJsonBody(streamRequest([], { a: 1 }))).resolves.toEqual({ a: 1 });
  });

  test("reads and parses the raw stream otherwise", async () => {
    await expect(readJsonBody(streamRequest(['{"a":', "2}"]))).resolves.toEqual({ a: 2 });
    await expect(readJsonBody(streamRequest([]))).resolves.toEqual({});
    await expect(readJsonBody(streamRequest(["not json"]))).rejects.toThrow(/not JSON/);
  });

  test("refuses oversized bodies", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    await expect(readJsonBody(streamRequest([big]))).rejects.toThrow(/too large/);
  });
});

test("a leg across ±180° is accepted and taken the short way round", () => {
  const r = parseRouteRequest({
    route: {
      type: "LineString",
      coordinates: [
        [179.9, 60],
        [-179.9, 60]
      ]
    }
  });
  expect(r.ok).toBe(true);
});
