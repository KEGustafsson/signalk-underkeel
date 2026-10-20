import { gunzipSync } from "zlib";
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

describe("UKC tile compression", () => {
  // Signal K's compression() leaves this type alone, so the route gzips it itself.
  const tile = new Uint8Array(4000).map((_, i) => i % 7);
  const api = {
    ukcTile: (z: number) => ({
      status: 200,
      contentType: "application/vnd.mapbox-vector-tile",
      body: z === 11 ? new Uint8Array([1, 2, 3]) : tile
    })
  } as unknown as ApiProvider;
  const fetchTile = (z: string, acceptEncoding?: string) => {
    const { router, call } = fakeRouter();
    registerRoutes(router as never, api);
    const headers: Record<string, string> =
      acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding };
    return call("/v1/tiles/ukc/:z/:x/:file", {}, { z, x: "0", file: "0.pbf" }, headers);
  };

  test("a client that accepts gzip gets the tile gzipped, and caches key on the encoding", () => {
    const r = fetchTile("16", "gzip, deflate, br");
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers.vary).toBe("Accept-Encoding");
    expect(r.type).toBe("application/vnd.mapbox-vector-tile");
    const sent = r.body as Buffer;
    expect(sent.length).toBeLessThan(tile.length / 4);
    expect(new Uint8Array(gunzipSync(sent))).toEqual(tile);
  });

  test.each([[undefined], ["identity"], ["gzip;q=0, *"], ["br"]])(
    "Accept-Encoding %p gets the tile as it is",
    (accept) => {
      const r = fetchTile("16", accept);
      expect(r.headers["content-encoding"]).toBeUndefined();
      expect(r.headers.vary).toBe("Accept-Encoding");
      expect(new Uint8Array(r.body as Buffer)).toEqual(tile);
    }
  );

  test("a tile below 1 kB is not worth compressing", () => {
    const r = fetchTile("11", "gzip");
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(new Uint8Array(r.body as Buffer)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
