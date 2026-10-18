import fs from "fs";
import os from "os";
import path from "path";
import { buildManifest } from "../../src/api/manifest";
import underkeel = require("../../src/index");
import { FIXTURES, M_PER_DEG_LON, ROCK } from "../helpers/fixture-index";
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
