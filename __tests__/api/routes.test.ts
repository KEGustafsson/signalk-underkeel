import type { ApiProvider } from "../../src/api/routes";
import { registerRoutes } from "../../src/api/routes";
import { fakeRouter } from "../helpers/plugin-harness";

/** How the REST layer turns handler failures into replies. */

describe("route errors", () => {
  test("a handler failure is a generic 500, never the raw message", async () => {
    const leak = () =>
      Promise.reject(new Error("EACCES: open '/srv/signalk/plugin-config-data/x.json'"));
    const api = { routeCheck: leak, routeRepair: leak, departureWindow: leak } as unknown;
    const { router, post } = fakeRouter();
    const logged: string[] = [];
    registerRoutes(router as never, api as ApiProvider, (m) => logged.push(m));
    for (const p of ["/v1/route-check", "/v1/route-repair", "/v1/departure-window"]) {
      expect(await post(p, {})).toEqual({ code: 500, body: { errors: ["internal error"] } });
    }
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatch(/EACCES: open '\/srv\/signalk\/plugin-config-data\/x\.json'/);
  });
});

describe("UKC tile headers", () => {
  test("UKC tiles change with the water level and vessel, so caches revalidate them", () => {
    const api = {
      ukcTile: () => ({
        status: 200,
        contentType: "application/vnd.mapbox-vector-tile",
        body: new Uint8Array([1])
      })
    } as unknown;
    const { router, call } = fakeRouter();
    registerRoutes(router as never, api as ApiProvider);
    const tile = call("/v1/tiles/ukc/:z/:x/:file", {}, { z: "16", x: "0", file: "0.pbf" });
    expect(tile.code).toBe(200);
    expect(tile.headers["cache-control"]).toBe("no-cache");
  });
});
