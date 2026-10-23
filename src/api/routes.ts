import type { Request, RequestHandler, Response } from "express";
import { gzipSync } from "zlib";
import type { Envelope } from "../engine/envelope";

export const API_BASE = "/v1";

export interface ApiReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface TileReply {
  status: number;
  contentType: string;
  body: Uint8Array | { errors: string[] };
}

export interface ApiProvider {
  status(summary: boolean): unknown;
  envelope(): { rev: number; envelope: Envelope };
  /** `signal` aborts when the client goes away. */
  routeCheck(body: unknown, signal: AbortSignal): Promise<ApiReply>;
  routeRepair(body: unknown, signal: AbortSignal): Promise<ApiReply>;
  departureWindow(body: unknown, signal: AbortSignal): Promise<ApiReply>;
  query(body: unknown, signal: AbortSignal): Promise<ApiReply>;
  ukcTile(z: number, x: number, y: number): TileReply;
  ukcTileChanges(query: Record<string, unknown>): ApiReply;
  ukcStyle(): unknown;
  acks(): ApiReply;
  addAck(body: unknown): ApiReply;
  deleteAck(id: string): ApiReply;
  discrepancies(): ApiReply;
  csb(): ApiReply;
}

type Registrar = {
  get(path: string, ...handlers: RequestHandler[]): unknown;
  post(path: string, ...handlers: RequestHandler[]): unknown;
  delete(path: string, ...handlers: RequestHandler[]): unknown;
};

/** Request bodies above this size are refused before parsing. */
export const MAX_BODY_BYTES = 256 * 1024;

/** A request body that is too large or not JSON: the client's fault, answered 400. */
class BodyError extends Error {}

/**
 * The parsed JSON body. Signal K runs express.json() before plugin routes,
 * and it leaves `{}` for a body of any other type; only without it is the
 * raw stream read here, with a size cap.
 */
export function readJsonBody(req: Request): Promise<unknown> {
  if (req.body !== undefined && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BodyError("request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The router Signal K hands to `registerWithRouter`. Routes registered on
 * it directly are admin-only; `access("readonly")` opens one to any logged
 * in user. Servers older than the access API only have the plain router.
 */
export interface RouterLike extends Registrar {
  access?(level: "readonly" | "readwrite"): Registrar;
}

function readonly(router: RouterLike): Registrar {
  return router.access ? router.access("readonly") : router;
}

/** Without the access API the plain router is admin-only, which is stricter still. */
function readwrite(router: RouterLike): Registrar {
  return router.access ? router.access("readwrite") : router;
}

/**
 * Any other failure is ours; its message may name files on the server, so it
 * stays off the wire and goes to the server log instead.
 */
function fail(res: Response, err: unknown, log: (message: string) => void): void {
  if (err instanceof BodyError) {
    res.status(400).json({ errors: [err.message] });
  } else {
    log(`REST handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    res.status(500).json({ errors: ["internal error"] });
  }
}

/**
 * Whether the request declares a JSON body. express.json() turns a form or
 * a body with no Content-Type into `{}`, which a write route would take as a
 * request with every field left to its default.
 */
function isJson(req: Request): boolean {
  const [type = ""] = String(req.headers?.["content-type"] ?? "").split(";");
  return /^application\/([\w.+-]+\+)?json$/.test(type.trim().toLowerCase());
}

function send(res: Response, reply: ApiReply): void {
  for (const [name, value] of Object.entries(reply.headers ?? {})) {
    res.setHeader(name, value);
  }
  if (reply.body === undefined) {
    res.status(reply.status).end();
  } else {
    res.status(reply.status).json(reply.body);
  }
}

/**
 * REST routes, base `/plugins/signalk-underkeel/v1` (plan §4.10). Reads
 * are open to readonly users; adding or deleting an acknowledgement needs
 * readwrite, and adding one a JSON body, so a cross-site form cannot. `GET
 * /envelope?rev=N` answers 304 when the client already holds rev N, so
 * clients can poll on the `envelopeRev` delta without refetching.
 */
export function registerRoutes(
  router: RouterLike,
  api: ApiProvider,
  log: (message: string) => void = console.error
): void {
  const r = readonly(router);
  r.get(`${API_BASE}/status`, (req: Request, res: Response) => {
    res.json(api.status(req.query?.summary !== undefined));
  });
  r.get(`${API_BASE}/envelope`, (req: Request, res: Response) => {
    const current = api.envelope();
    const rev = Number(req.query?.rev);
    if (Number.isInteger(rev) && rev === current.rev) {
      res.status(304).end();
      return;
    }
    res.json(current);
  });
  for (const [route, handler] of [
    ["route-check", api.routeCheck],
    ["route-repair", api.routeRepair],
    ["departure-window", api.departureWindow],
    ["query", api.query]
  ] as const) {
    r.post(`${API_BASE}/${route}`, (req: Request, res: Response) => {
      const client = new AbortController();
      // Also after the reply is sent, when nothing is left to abort.
      res.on("close", () => client.abort(new Error("client disconnected")));
      readJsonBody(req)
        .then((body) => handler(body, client.signal))
        .then((reply) => send(res, reply))
        .catch((err: unknown) => fail(res, err, log));
    });
  }
  r.get(`${API_BASE}/tiles/ukc/:z/:x/:file`, (req: Request, res: Response) => {
    const p = (req.params ?? {}) as Record<string, string | undefined>;
    const y = /^(\d{1,8})\.pbf$/.exec(p.file ?? "")?.[1];
    const reply = api.ukcTile(int(p.z), int(p.x), int(y));
    // The tiles follow the water level and vessel: Plotter Extensions §Live changes.
    res.setHeader("Cache-Control", "no-cache");
    if (reply.body instanceof Uint8Array) {
      res.setHeader("Vary", "Accept-Encoding");
      // Signal K's compression() skips this content type; it leaves an encoded body alone.
      const gzip =
        reply.body.length >= GZIP_MIN_BYTES && acceptsGzip(req.headers?.["accept-encoding"]);
      if (gzip) {
        res.setHeader("Content-Encoding", "gzip");
      }
      const body = gzip ? gzipSync(reply.body) : Buffer.from(reply.body);
      res.status(reply.status).type(reply.contentType).send(body);
    } else {
      res.status(reply.status).json(reply.body);
    }
  });
  r.get(`${API_BASE}/tiles/ukc/changes`, (req: Request, res: Response) =>
    send(res, api.ukcTileChanges((req.query ?? {}) as Record<string, unknown>))
  );
  r.get(`${API_BASE}/ukc-style.json`, (_req: Request, res: Response) => {
    res.json(api.ukcStyle());
  });
  r.get(`${API_BASE}/acks`, (_req: Request, res: Response) => send(res, api.acks()));
  r.get(`${API_BASE}/livechart/discrepancies`, (_req: Request, res: Response) =>
    send(res, api.discrepancies())
  );
  r.get(`${API_BASE}/livechart/csb.geojson`, (_req: Request, res: Response) =>
    send(res, api.csb())
  );
  const w = readwrite(router);
  w.post(`${API_BASE}/acks`, (req: Request, res: Response) => {
    if (!isJson(req)) {
      res.status(415).json({ errors: ["Content-Type must be application/json"] });
      return;
    }
    readJsonBody(req)
      .then((body) => send(res, api.addAck(body)))
      .catch((err: unknown) => fail(res, err, log));
  });
  w.delete(`${API_BASE}/acks/:id`, (req: Request, res: Response) => {
    send(res, api.deleteAck(String((req.params as Record<string, unknown> | undefined)?.id ?? "")));
  });
}

/** Smaller bodies gain less from gzip than its header costs; compression() uses the same. */
const GZIP_MIN_BYTES = 1024;

/** Whether an Accept-Encoding header accepts gzip, by name or `*`, with a q above 0. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  let any = false;
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.split(";").map((t) => t.trim().toLowerCase());
    const q = params.find((p) => p.startsWith("q="));
    const accepted = q === undefined || Number(q.slice(2)) > 0;
    if (name === "gzip") {
      return accepted;
    }
    if (name === "*") {
      any = accepted;
    }
  }
  return any;
}

/** A path segment as a non-negative integer, else NaN. */
function int(s: string | undefined): number {
  return s !== undefined && /^\d{1,8}$/.test(s) ? Number(s) : NaN;
}
