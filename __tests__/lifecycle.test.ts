import fs from "fs";
import os from "os";
import path from "path";
import underkeel = require("../src/index");
import { FIXTURES, ROCK } from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, T0 } from "./helpers/plugin-harness";

/** What the plugin answers and publishes once it is stopped or restarted. */

describe("after stop", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-lifecycle-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

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
});
