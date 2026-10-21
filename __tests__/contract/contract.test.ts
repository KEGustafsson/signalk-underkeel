import fs from "fs";
import os from "os";
import path from "path";
import { parseAckRequest } from "../../src/api/ack-request";
import { buildManifest } from "../../src/api/manifest";
import { parseQueryRequest } from "../../src/api/query-request";
import { parseRouteRequest } from "../../src/api/route-request";
import underkeel = require("../../src/index");
import { FIXTURES, M_PER_DEG_LON, ROCK, seedFixtureIndex } from "../helpers/fixture-index";
import { Validator } from "../helpers/json-schema";
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "../helpers/plugin-harness";
import { stubProvider } from "./stub-provider";

/**
 * Contract tests (plan §7, M6): this plugin's responses and a second,
 * stub provider both validate against the shared navigation-safety
 * schemas, so a plotter written against the schemas works with either.
 */

const v = new Validator();

const ROUTE = {
  type: "LineString",
  coordinates: [
    [22.004, 60.01],
    [22.03, 60.01]
  ]
};

function expectValid(schema: string, value: unknown): void {
  expect(v.validate(schema, value)).toEqual([]);
}

describe("schema validator", () => {
  test("reports type, enum, required and range errors with their location", () => {
    expect(v.validate("defs.json", {})).toEqual([]);
    const errors = v.validate("query-response.json", {
      class: "fine",
      charted: "3",
      mean: null,
      sigma: -1,
      risk: 2,
      flags: [],
      cells: [{ edition: 1 }]
    });
    expect(errors).toEqual([
      '$.class: "fine" not in ["clear","caution","danger","unverified"]',
      '$.charted: expected number,null, got "3"',
      "$.sigma: -1 < 0",
      "$.risk: 2 > 1",
      "$.cells[0]: missing update"
    ]);
  });

  test("a keyword the validator does not implement is an error, not a pass", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-"));
    fs.writeFileSync(path.join(dir, "x.json"), JSON.stringify({ oneOf: [] }));
    expect(() => new Validator(dir).validate("x.json", 1)).toThrow(/unsupported keyword oneOf/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a route request names its route inline, by reference, or both", () => {
    const ref = "/resources/routes/abc";
    expectValid("route-check-request.json", { route: ROUTE });
    expectValid("route-check-request.json", { routeRef: ref });
    expectValid("route-check-request.json", { route: ROUTE, routeRef: ref });
    expect(v.validate("route-check-request.json", { speed: 3 })).toEqual([
      "$: matches no anyOf branch ($: missing route; $: missing routeRef)"
    ]);
  });

  test("every schema parses and names itself by file", () => {
    for (const name of v.names()) {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "..", "schemas", "navigation-safety", name),
          "utf8"
        )
      ) as { $id?: string };
      expect(raw.$id).toBe(name);
    }
  });
});

describe("signalk-underkeel satisfies the contract", () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-contract-"));
  });
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("query and acknowledgement requests the schemas allow are accepted", () => {
    const square = {
      type: "Polygon",
      coordinates: [
        [
          [22.0, 60.0],
          [22.01, 60.0],
          [22.01, 60.01],
          [22.0, 60.01],
          [22.0, 60.0]
        ]
      ]
    };
    const point = {
      geometry: { type: "Point", coordinates: ROCK },
      bufferMetres: 20,
      draft: 2,
      speed: 3
    };
    for (const body of [point, { geometry: square }]) {
      expectValid("query-request.json", body);
      expect(parseQueryRequest(body).ok).toBe(true);
    }
    expect(v.validate("query-request.json", {})).toEqual(["$: missing geometry"]);
    expect(v.validate("query-request.json", { geometry: ROUTE })).toHaveLength(1);
    const ack = { polygon: square, sector: 20, ttl: 600, notificationId: "n1" };
    for (const body of [ack, {}]) {
      expectValid("ack-request.json", body);
      expect(parseAckRequest(body).ok).toBe(true);
    }
    expect(v.validate("ack-request.json", { ttl: 0 })).toEqual(["$.ttl: 0 < 1"]);
  });

  test("a request field the schemas allow is one the parsers accept, edge to edge", () => {
    const point = { type: "Point", coordinates: ROCK };
    const cases: [
      string,
      (b: unknown) => { ok: boolean },
      Record<string, unknown>,
      unknown[],
      unknown[]
    ][] = [
      ["ack-request.json", parseAckRequest, { sector: 1 }, [1, 90], [0.5, 91]],
      ["ack-request.json", parseAckRequest, { ttl: 1 }, [1, 30 * 86400], [0.5, 30 * 86400 + 1]],
      [
        "ack-request.json",
        parseAckRequest,
        { notificationId: "" },
        ["x".repeat(200)],
        ["x".repeat(201), 123]
      ],
      ["query-request.json", parseQueryRequest, { bufferMetres: 0 }, [0, 2000], [-1, 2001]],
      ["query-request.json", parseQueryRequest, { draft: 0.1 }, [0.1, 30], [0.05, 31]],
      ["query-request.json", parseQueryRequest, { speed: 0 }, [0, 30], [-1, 31]],
      ["route-check-request.json", parseRouteRequest, { xteLimit: 0 }, [0, 2000], [-1, 2001]],
      ["route-check-request.json", parseRouteRequest, { probability: 1e-6 }, [1e-6, 0.5], [0, 0.6]],
      [
        "route-check-request.json",
        parseRouteRequest,
        { vessel: { draft: 0.01 } },
        [0.01, 30],
        [0, 31]
      ],
      [
        "route-check-request.json",
        parseRouteRequest,
        { speed: 0.1 },
        [0.1, 30, [0.1, 30], { default: 30 }, { legs: [0.1] }],
        [0, 31, [3, 31], { default: 0 }, { legs: [0] }, {}, [], { legs: [] }]
      ]
    ];
    for (const [schema, parse, field, inside, outside] of cases) {
      const key = Object.keys(field)[0] as string;
      const body = (value: unknown) => ({
        ...(schema === "query-request.json" ? { geometry: point } : { route: ROUTE }),
        [key]: key === "vessel" ? { draft: value } : value
      });
      for (const value of inside) {
        expectValid(schema, body(value));
        expect([key, value, parse(body(value)).ok]).toEqual([key, value, true]);
      }
      for (const value of outside) {
        expect([key, value, v.validate(schema, body(value)).length > 0]).toEqual([
          key,
          value,
          true
        ]);
        expect([key, value, parse(body(value)).ok]).toEqual([key, value, false]);
      }
    }
  });

  test("manifest, REST responses and the notification", async () => {
    expectValid(
      "service.json",
      buildManifest("0.1.0")["signalk-underkeel"]?.services.navigationSafety
    );
    expectValid("route-check-request.json", { route: ROUTE, speed: 3, probability: 0.01 });

    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
    const clock = fakeClock(T0);
    const plugin = underkeel(f.app, clock);
    const { router, call, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    seedFixtureIndex(dataDir);
    plugin.start({ cellsDir: FIXTURES, leafZoom: 18 }, () => undefined);
    f.send(navDelta(ROCK[0] - 75 / M_PER_DEG_LON, ROCK[1], 3, T0));
    clock.advance(1000);

    expectValid(
      "route-check-response.json",
      (await post("/v1/route-check", { route: ROUTE })).body
    );
    expectValid(
      "route-repair-response.json",
      (await post("/v1/route-repair", { route: ROUTE })).body
    );
    expectValid(
      "departure-window-response.json",
      (await post("/v1/departure-window", { route: ROUTE, horizon: 3600 })).body
    );
    expectValid(
      "query-response.json",
      (await post("/v1/query", { geometry: { type: "Point", coordinates: ROCK } })).body
    );
    expectValid("envelope-response.json", call("/v1/envelope").body);
    const ack = await post("/v1/acks", { ttl: 600 });
    expect(ack.code).toBe(201);
    expectValid("ack.json", ack.body);
    expectValid("notification.json", lastValue(f.deltas, "notifications.navigation.underKeel"));
    const bad = await post("/v1/route-check", { route: { type: "Point" } });
    expect(bad.code).toBe(400);
    expectValid("error.json", bad.body);
    expect(v.validate("error.json", { errors: [] })).toEqual(["$.errors: fewer than 1 items"]);
    plugin.stop();
  });
  test("the off, unknown and stopped notifications validate too", () => {
    const notification = (options: Record<string, unknown>) => {
      const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.6 } } });
      const clock = fakeClock(T0);
      const plugin = underkeel(f.app, clock);
      plugin.start(options, () => undefined);
      clock.advance(1000);
      const running = lastValue(f.deltas, "notifications.navigation.underKeel");
      plugin.stop();
      return { running, stopped: lastValue(f.deltas, "notifications.navigation.underKeel") };
    };
    const off = notification({ indexDir: path.join(dataDir, "no-index") });
    seedFixtureIndex(dataDir);
    const unknown = notification({ cellsDir: FIXTURES, leafZoom: 18 });
    expect(off.running).toMatchObject({ data: { engineState: "off" } });
    expect(unknown.running).toMatchObject({ data: { engineState: "unknown" } });
    for (const n of [off.running, unknown.running, off.stopped, unknown.stopped]) {
      expectValid("notification.json", n);
    }
  });
});

describe("a second provider satisfies the same contract", () => {
  test("the stub's manifest section and responses validate", () => {
    const stub = stubProvider();
    expectValid("service.json", stub.service);
    expectValid(
      "route-check-response.json",
      stub.routeCheck(ROUTE.coordinates as [number, number][])
    );
    expectValid("query-response.json", stub.query());
    expectValid("envelope-response.json", stub.envelope());
    expectValid("notification.json", stub.notification());
  });
});
