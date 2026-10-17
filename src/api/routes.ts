import type { Request, RequestHandler, Response } from "express";
import type { Envelope } from "../engine/envelope";

export const API_BASE = "/v1";

export interface ApiProvider {
  status(): unknown;
  envelope(): { rev: number; envelope: Envelope };
}

type Registrar = { get(path: string, ...handlers: RequestHandler[]): unknown };

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
 * Read-only REST routes, base `/plugins/signalk-underkeel/v1` (plan §4.10).
 * `GET /envelope?rev=N` answers 304 when the client already holds rev N, so
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
}
