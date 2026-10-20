import { UKC_MIN_ZOOM } from "./api/manifest";
import { encodeMvt, MVT_EXTENT } from "./api/mvt";
import { parseQueryRequest } from "./api/query-request";
import type { ApiReply, TileReply } from "./api/routes";
import type { PluginConfig } from "./config";
import type { RequestQueue } from "./route-service";
import { queryUkc } from "./engine/query";
import { ukcTile } from "./engine/ukc-tiles";
import type { WaterLevel } from "./model/uncertainty";
import { sigmaExtra, thresholdDepth } from "./model/uncertainty";
import type { VesselModel } from "./model/vessel";
import { FALLBACK_HULL, vesselTerms } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";

/** `POST /query` and `GET /tiles/ukc/{z}/{x}/{y}.pbf` for the current vessel and water level. */

export interface QueryServiceDeps {
  index: ChartIndex | undefined;
  indexReason: string | undefined;
  config: PluginConfig;
  vessel(): VesselModel | undefined;
  waterLevel(): WaterLevel;
  waveHeight(): number | undefined;
}

function unavailable(deps: QueryServiceDeps): ApiReply | undefined {
  if (!deps.index) {
    return { status: 503, body: { errors: [deps.indexReason ?? "no chart index loaded"] } };
  }
  return undefined;
}

/** Runs in `queue`, since a large polygon can take some milliseconds on the event loop. */
export async function query(
  body: unknown,
  deps: QueryServiceDeps,
  queue: RequestQueue,
  client: AbortSignal
): Promise<ApiReply> {
  const parsed = parseQueryRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: { errors: parsed.errors } };
  }
  const down = unavailable(deps);
  if (down) {
    return down;
  }
  const req = parsed.value;
  const current = deps.vessel();
  const vessel =
    req.draft === undefined ? current : { ...(current ?? FALLBACK_HULL), draft: req.draft };
  if (!vessel) {
    return { status: 422, body: { errors: ["vessel draft not configured"] } };
  }
  const terms = vesselTerms(
    vessel,
    { speed: req.speed ?? 0, waveHeight: deps.waveHeight() },
    deps.config.dynamics
  );
  const index = deps.index as ChartIndex;
  return await queue.run(client, () =>
    Promise.resolve({
      status: 200,
      body: queryUkc(index, {
        ring: req.ring,
        bufferMetres: req.bufferMetres ?? 0,
        terms,
        waterLevel: deps.waterLevel(),
        thresholds: deps.config.lookahead.thresholds
      })
    })
  );
}

const MVT_TYPE = "application/vnd.mapbox-vector-tile";

export function ukcTileReply(z: number, x: number, y: number, deps: QueryServiceDeps): TileReply {
  const json = "application/json";
  if (!(Number.isInteger(z) && z >= 0 && z <= 24 && inTile(x, z) && inTile(y, z))) {
    return { status: 400, contentType: json, body: { errors: ["invalid tile address"] } };
  }
  const down = unavailable(deps);
  if (down) {
    return { status: down.status, contentType: json, body: down.body as { errors: string[] } };
  }
  const vessel = deps.vessel();
  if (!vessel) {
    return { status: 422, contentType: json, body: { errors: ["vessel draft not configured"] } };
  }
  if (z < UKC_MIN_ZOOM) {
    return { status: 200, contentType: MVT_TYPE, body: encodeMvt("ukc", []) };
  }
  const wl = deps.waterLevel();
  const terms = vesselTerms(
    vessel,
    { speed: 0, waveHeight: deps.waveHeight() },
    deps.config.dynamics
  );
  const rects = ukcTile((deps.index as ChartIndex).pyramid, z, x, y, MVT_EXTENT, {
    threshold: thresholdDepth(terms, wl),
    sigmaExtra: sigmaExtra(terms, wl),
    thresholds: deps.config.lookahead.thresholds,
    degraded: wl.degraded !== undefined
  });
  const byClass = new Map<string, [number, number][][]>();
  for (const r of rects) {
    const rings = byClass.get(r.class) ?? [];
    rings.push([
      [r.x0, r.y0],
      [r.x1, r.y0],
      [r.x1, r.y1],
      [r.x0, r.y1]
    ]);
    byClass.set(r.class, rings);
  }
  const features = [...byClass].map(([cls, rings]) => ({ rings, properties: { class: cls } }));
  return { status: 200, contentType: MVT_TYPE, body: encodeMvt("ukc", features) };
}

function inTile(v: number, z: number): boolean {
  return Number.isInteger(v) && v >= 0 && v < 2 ** z;
}
