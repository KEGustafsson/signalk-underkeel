import type { Request, RequestHandler, Response } from "express";
import type { Envelope } from "../engine/envelope";

export const API_BASE = "/v1";

export interface ApiReply {
  status: number;
  body: unknown;
}

export interface TileReply {
  status: number;
  contentType: string;
  body: Uint8Array | { errors: string[] };
}

export interface ApiProvider {
  status(): unknown;
  envelope(): { rev: number; envelope: Envelope };
  routeCheck(body: unknown): Promise<ApiReply>;
  query(body: unknown): ApiReply;
  ukcTile(z: number, x: number, y: number): TileReply;
  ukcStyle(): unknown;
}

type Registrar = {
  get(path: string, ...handlers: RequestHandler[]): unknown;
  post(path: string, ...handlers: RequestHandler[]): unknown;
};

/** Request bodies above this size are refused before parsing. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * The parsed JSON body. Signal K normally runs express.json() before plugin
 * routes; when it has not, the raw stream is read here with a size cap.
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
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not JSON"));
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

/**
 * REST routes, base `/plugins/signalk-underkeel/v1` (plan §4.10). None of
 * them changes state, so all are open to readonly users. `GET
 * /envelope?rev=N` answers 304 when the client already holds rev N, so
 * clients can poll on the `envelopeRev` delta without refetching.
 */
export function registerRoutes(router: RouterLike, api: ApiProvider): void {
  const r = readonly(router);
  r.get(`${API_BASE}/status`, (_req: Request, res: Response) => {
    res.json(api.status());
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
  r.post(`${API_BASE}/route-check`, (req: Request, res: Response) => {
    readJsonBody(req)
      .then((body) => api.routeCheck(body))
      .then((reply) => res.status(reply.status).json(reply.body))
      .catch((err: Error) => res.status(400).json({ errors: [err.message] }));
  });
  r.post(`${API_BASE}/query`, (req: Request, res: Response) => {
    readJsonBody(req)
      .then((body) => {
        const reply = api.query(body);
        res.status(reply.status).json(reply.body);
      })
      .catch((err: Error) => res.status(400).json({ errors: [err.message] }));
  });
  r.get(`${API_BASE}/tiles/ukc/:z/:x/:file`, (req: Request, res: Response) => {
    const p = (req.params ?? {}) as Record<string, string | undefined>;
    const y = /^(\d{1,8})\.pbf$/.exec(p.file ?? "")?.[1];
    const reply = api.ukcTile(int(p.z), int(p.x), int(y));
    if (reply.body instanceof Uint8Array) {
      res.status(reply.status).type(reply.contentType).send(Buffer.from(reply.body));
    } else {
      res.status(reply.status).json(reply.body);
    }
  });
  r.get(`${API_BASE}/ukc-style.json`, (_req: Request, res: Response) => {
    res.json(api.ukcStyle());
  });
}

/** A path segment as a non-negative integer, else NaN. */
function int(s: string | undefined): number {
  return s !== undefined && /^\d{1,8}$/.test(s) ? Number(s) : NaN;
}
