import { UKC_MIN_ZOOM } from "./api/manifest";
import { encodeMvt, MVT_EXTENT } from "./api/mvt";
import { parseQueryRequest } from "./api/query-request";
import type { ApiReply, TileReply } from "./api/routes";
import type { TileInputs, UkcTileChanges } from "./api/ukc-tile-changes";
import type { PluginConfig } from "./config";
import type { RequestQueue } from "./route-service";
import { queryUkc } from "./engine/query";
import type { UkcTileCache } from "./engine/ukc-tile-cache";
import type { UkcRect, UkcTileInput } from "./engine/ukc-tiles";
import { ukcTileWithRange } from "./engine/ukc-tiles";
import type { AreaLevels } from "./model/level-regimes";
import { levelOver, ringCorners, tileCorners, withinReach } from "./model/level-regimes";
import type { WaterLevel } from "./model/uncertainty";
import { sigmaExtra, thresholdDepth } from "./model/uncertainty";
import type { VesselModel } from "./model/vessel";
import { FALLBACK_HULL, vesselTerms } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";

/**
 * `POST /query` and `GET /tiles/ukc/{z}/{x}/{y}.pbf` for the current vessel
 * and the water level where each tile or polygon is.
 */

export interface QueryServiceDeps {
  index: ChartIndex | undefined;
  indexReason: string | undefined;
  config: PluginConfig;
  vessel(): VesselModel | undefined;
  /** The level where each area is (plan §4.5): tiles and /query never take the vessel's level. */
  levelRegimes(): AreaLevels;
  waveHeight(): number | undefined;
  /** Which served tiles changed, for `GET /tiles/ukc/changes`. */
  tileChanges?: UkcTileChanges;
  /** The tiles' level-independent geometry, kept between requests. */
  tileCache?: UkcTileCache;
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
        // At the ring, not the vessel: a forecast for the vessel's sea area adds water
        // that may not be there a few tens of kilometres away.
        waterLevel: levelOver(deps.levelRegimes(), ringCorners(req.ring, req.bufferMetres ?? 0)),
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
  return drawnReply(z, x, y, vessel, deps);
}

/** The tile at the water level where it is, recorded in the change list. */
function drawnReply(
  z: number,
  x: number,
  y: number,
  vessel: VesselModel,
  deps: QueryServiceDeps
): TileReply {
  const t = tileInput(vessel, deps);
  deps.tileChanges?.observe(t.inputs);
  const inside = t.inputs.beyond?.within(z, x, y) ?? true;
  const input = inside || !t.beyond ? t.inside : t.beyond;
  const { store } = t.inputs;
  // The bytes last encoded, when the input is one they were drawn at (and the cache has
  // seen no change to the index or the cells since): the same bytes, for the same range.
  const kept = deps.tileCache?.drawnTile(store, z, x, y, input);
  if (kept) {
    deps.tileChanges?.serve(z, x, y, kept.range, inside);
    return { status: 200, contentType: MVT_TYPE, body: kept.body, memo: kept };
  }
  const { rects, range } = ukcTileWithRange(store, z, x, y, MVT_EXTENT, input, deps.tileCache);
  deps.tileChanges?.serve(z, x, y, range, inside);
  const body = encodeTile(rects);
  const memo = deps.tileCache?.keepDrawn(store, z, x, y, input, range, body);
  return { status: 200, contentType: MVT_TYPE, body, ...(memo && { memo }) };
}

/** One feature per class, and per class raised by a nearby cell's chart position or flags. */
function encodeTile(rects: UkcRect[]): Uint8Array {
  const byClass = new Map<string, [number, number][][]>();
  for (const r of rects) {
    const key = r.reach ? `${r.class}|reach` : r.class;
    const rings = byClass.get(key) ?? [];
    rings.push([
      [r.x0, r.y0],
      [r.x1, r.y0],
      [r.x1, r.y1],
      [r.x0, r.y1]
    ]);
    byClass.set(key, rings);
  }
  const features = [...byClass].map(([key, rings]) => {
    const [cls, reach] = key.split("|");
    const properties: Record<string, string> = { class: cls as string };
    if (reach) {
      properties.reach = "1";
    }
    return { rings, properties };
  });
  return encodeMvt("ukc", features);
}

/**
 * The served tiles a client should fetch again since its cursor (`epoch`,
 * `rev`). A malformed or foreign cursor gets `all`.
 */
export function ukcTileChangesReply(
  query: Record<string, unknown>,
  deps: QueryServiceDeps
): ApiReply {
  const changes = deps.tileChanges;
  if (!changes) {
    return { status: 404, body: { errors: ["no tile change list"] } };
  }
  const vessel = deps.vessel();
  if (deps.index && vessel) {
    changes.observe(tileInput(vessel, deps).inputs);
  }
  const { epoch, rev } = query;
  const cursor =
    epoch === undefined && rev === undefined
      ? undefined
      : {
          epoch: String(epoch),
          rev: typeof rev === "string" && /^\d{1,15}$/.test(rev) ? Number(rev) : NaN
        };
  return { status: 200, body: changes.since(cursor) };
}

/** The tile inputs at the level inside the source's reach and, when it has one, beyond it. */
function tileInput(
  vessel: VesselModel,
  deps: QueryServiceDeps
): { inside: UkcTileInput; beyond?: UkcTileInput; inputs: TileInputs } {
  const levels = deps.levelRegimes();
  const terms = vesselTerms(
    vessel,
    { speed: 0, waveHeight: deps.waveHeight() },
    deps.config.dynamics
  );
  const { thresholds } = deps.config.lookahead;
  const inputFor = (wl: WaterLevel): UkcTileInput => {
    const exact = sigmaExtra(terms, wl);
    return {
      threshold: thresholdDepth(terms, wl),
      // A forecast's sigma grows with lead time and a wave reading moves each second; at full
      // precision every poll would refresh every tile. Rounded up, P rises above the threshold
      // and stays at least 1/2 past it, so no cell reads safer while the warn level is at most
      // 1/2; above that a wider sigma could lower a P past the threshold below it.
      sigmaExtra: thresholds.warn <= 0.5 ? Math.ceil(exact * 100) / 100 : exact,
      thresholds,
      degraded: wl.degraded !== undefined
    };
  };
  const inside = inputFor(levels.inside);
  const far = levels.beyond;
  const beyond = far && inputFor(far.level);
  const part = (i: UkcTileInput): string => `${i.sigmaExtra}|${i.degraded}`;
  const { alert, warn } = thresholds;
  const inputs: TileInputs = {
    store: (deps.index as ChartIndex).pyramid,
    key: `${part(inside)}|${beyond ? part(beyond) : "-"}|${alert}|${warn}`,
    threshold: inside.threshold
  };
  if (far && beyond) {
    const { centre, metres } = far.reach;
    inputs.beyond = {
      threshold: beyond.threshold,
      reach: `${centre[0]},${centre[1]},${metres}`,
      within: (z, x, y) => withinReach(far.reach, tileCorners(z, x, y))
    };
  }
  return beyond ? { inside, beyond, inputs } : { inside, inputs };
}

function inTile(v: number, z: number): boolean {
  return Number.isInteger(v) && v >= 0 && v < 2 ** z;
}
