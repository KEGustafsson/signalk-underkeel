import { Readable } from "stream";
import { gunzipSync, gzipSync } from "zlib";
import type { Request, RequestHandler, Response } from "express";
import type { ApiProvider, TileReply } from "../../src/api/routes";
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

describe("acknowledgement content type", () => {
  // express.json() leaves `{}` for any other type: the request would become a default ack.
  const setup = () => {
    const bodies: unknown[] = [];
    const api = {
      addAck: (body: unknown) => {
        bodies.push(body);
        return { status: 201, body: { id: "a" } };
      }
    } as unknown as ApiProvider;
    const { router, post } = fakeRouter();
    registerRoutes(router as never, api);
    return { bodies, post };
  };

  test.each([
    [{}],
    [{ "content-type": "text/plain" }],
    [{ "content-type": "multipart/form-data" }]
  ])("POST /acks with headers %p is refused 415 and adds nothing", async (headers) => {
    const { bodies, post } = setup();
    expect(await post("/v1/acks", {}, headers)).toEqual({
      code: 415,
      body: { errors: ["Content-Type must be application/json"] }
    });
    expect(bodies).toEqual([]);
  });

  test.each([["application/json"], ["Application/JSON; charset=utf-8"], ["application/geo+json"]])(
    "POST /acks with Content-Type %s is taken",
    async (type) => {
      const { bodies, post } = setup();
      expect((await post("/v1/acks", { ttl: 600 }, { "content-type": type })).code).toBe(201);
      expect(bodies).toEqual([{ ttl: 600 }]);
    }
  );

  test("a +json body the server's parser left as {} is read from the stream, ttl and all", async () => {
    // Signal K's express.json() parses only application/json: for application/geo+json it
    // sets `req.body = {}` and leaves the stream unread. Taking that `{}` would store a
    // default acknowledgement that never expires.
    const bodies: unknown[] = [];
    const api = {
      addAck: (body: unknown) => {
        bodies.push(body);
        return { status: 201, body: { id: "a" } };
      }
    } as unknown as ApiProvider;
    let handler: RequestHandler | undefined;
    const add = (p: string, h: RequestHandler) => {
      if (p === "/v1/acks") {
        handler = h;
      }
    };
    registerRoutes({ get: add, post: add, delete: add }, api);
    const req = Object.assign(Readable.from([Buffer.from('{"ttl":600}')]), {
      body: {},
      headers: { "content-type": "application/geo+json" }
    });
    const code = await new Promise<number>((resolve) => {
      const res = {
        status: (c: number) => ({ json: () => resolve(c), end: () => resolve(c) }),
        setHeader: () => undefined
      };
      handler?.(req as unknown as Request, res as unknown as Response, () => undefined);
    });
    expect(code).toBe(201);
    expect(bodies).toEqual([{ ttl: 600 }]);
  });
});

describe("server error reasons on the wire", () => {
  test("a 503 from a POST route or a tile carries the reason without its paths", async () => {
    const reason = "no cells in /srv/charts";
    const unavailable = () => Promise.resolve({ status: 503, body: { errors: [reason] } });
    const api = {
      query: unavailable,
      ukcTile: () => ({ status: 503, contentType: "application/json", body: { errors: [reason] } })
    } as unknown as ApiProvider;
    const { router, call, post } = fakeRouter();
    registerRoutes(router as never, api);
    const wire = { errors: ["no cells in <path>"] };
    expect(await post("/v1/query", {})).toEqual({ code: 503, body: wire });
    const tile = call("/v1/tiles/ukc/:z/:x/:file", {}, { z: "16", x: "0", file: "0.pbf" });
    expect(tile).toMatchObject({ code: 503, body: wire });
  });

  test("a 4xx reply is the client's and goes out as it is", async () => {
    const api = {
      query: () => Promise.resolve({ status: 400, body: { errors: ["geometry: /bad"] } })
    } as unknown as ApiProvider;
    const { router, post } = fakeRouter();
    registerRoutes(router as never, api);
    expect(await post("/v1/query", {})).toEqual({
      code: 400,
      body: { errors: ["geometry: /bad"] }
    });
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
  // Signal K's compression() leaves this type alone, so the route gzips it itself, off the event loop.
  const tile = new Uint8Array(4000).map((_, i) => i % 7);
  const small = new Uint8Array([1, 2, 3]);
  const TYPE = "application/vnd.mapbox-vector-tile";

  /** The route's reply to one tile request, once it is sent. */
  const fetchReply = (reply: TileReply, acceptEncoding?: string) => {
    const api = { ukcTile: () => reply } as unknown as ApiProvider;
    let handler: RequestHandler | undefined;
    const add = (p: string, h: RequestHandler) => {
      if (p === "/v1/tiles/ukc/:z/:x/:file") {
        handler = h;
      }
    };
    registerRoutes({ get: add, post: add, delete: add }, api);
    return new Promise<{ headers: Record<string, string>; type?: string; body: Buffer }>(
      (resolve) => {
        const headers: Record<string, string> = {};
        let type: string | undefined;
        const res = {
          setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
          status: () => res,
          type: (t: string) => {
            type = t;
            return res;
          },
          send: (body: Buffer) => resolve({ headers, type, body })
        };
        const reqHeaders: Record<string, string> =
          acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding };
        handler?.(
          { params: { z: "16", x: "0", file: "0.pbf" }, headers: reqHeaders } as unknown as Request,
          res as unknown as Response,
          () => undefined
        );
      }
    );
  };
  const fetchTile = (z: string, acceptEncoding?: string) =>
    fetchReply({ status: 200, contentType: TYPE, body: z === "11" ? small : tile }, acceptEncoding);

  test("a client that accepts gzip gets the tile gzipped, and caches key on the encoding", async () => {
    const r = await fetchTile("16", "gzip, deflate, br");
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers.vary).toBe("Accept-Encoding");
    expect(r.type).toBe(TYPE);
    expect(r.body.length).toBeLessThan(tile.length / 4);
    expect(new Uint8Array(gunzipSync(r.body))).toEqual(tile);
  });

  test("the gzip is the bytes gzipSync gives, and the reply's memo keeps it for the next request", async () => {
    const memo: { gzip?: Uint8Array } = {};
    const reply: TileReply = { status: 200, contentType: TYPE, body: tile, memo };
    const first = await fetchReply(reply, "gzip");
    expect(first.body.equals(gzipSync(tile))).toBe(true);
    expect(memo.gzip).toEqual(new Uint8Array(first.body));
    // A kept gzip is sent as it is: the stand-in below could not come from compressing.
    memo.gzip = new Uint8Array([9, 9, 9]);
    const second = await fetchReply(reply, "gzip");
    expect(second.headers["content-encoding"]).toBe("gzip");
    expect(new Uint8Array(second.body)).toEqual(new Uint8Array([9, 9, 9]));
    const plain = await fetchReply(reply, "identity");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(new Uint8Array(plain.body)).toEqual(tile);
  });

  test("the event loop runs while a tile is compressed", async () => {
    const big = new Uint8Array(2 * 2 ** 20).map((_, i) => (i * 2654435761) >>> 24);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const r = await fetchReply({ status: 200, contentType: TYPE, body: big }, "gzip");
    clearInterval(timer);
    expect(new Uint8Array(gunzipSync(r.body))).toEqual(big);
    expect(ticks).toBeGreaterThan(0);
  });

  test.each([[undefined], ["identity"], ["gzip;q=0, *"], ["br"]])(
    "Accept-Encoding %p gets the tile as it is",
    async (accept) => {
      const r = await fetchTile("16", accept);
      expect(r.headers["content-encoding"]).toBeUndefined();
      expect(r.headers.vary).toBe("Accept-Encoding");
      expect(new Uint8Array(r.body)).toEqual(tile);
    }
  );

  test("a tile below 1 kB is not worth compressing", async () => {
    const r = await fetchTile("11", "gzip");
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(new Uint8Array(r.body)).toEqual(small);
  });
});
