import type { ApiProvider } from "../../src/api/routes";
import { registerRoutes } from "../../src/api/routes";
import { fakeRouter } from "../helpers/plugin-harness";

/** How the REST layer turns handler failures into replies. */

describe("route errors", () => {
  test("a handler failure is a generic 500, never the raw message", async () => {
    const leak = () => Promise.reject(new Error("EACCES: open '/home/pi/.signalk/x.json'"));
    const api = { routeCheck: leak, routeRepair: leak, departureWindow: leak } as unknown;
    const { router, post } = fakeRouter();
    registerRoutes(router as never, api as ApiProvider);
    for (const p of ["/v1/route-check", "/v1/route-repair", "/v1/departure-window"]) {
      expect(await post(p, {})).toEqual({ code: 500, body: { errors: ["internal error"] } });
    }
  });
});
