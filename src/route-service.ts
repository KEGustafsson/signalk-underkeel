import type { ApiReply } from "./api/routes";
import { parseRouteRequest, routeResourceCoordinates, speedsFor } from "./api/route-request";
import type { PluginConfig } from "./config";
import { checkRoute } from "./engine/route-check";
import type { LonLat } from "./foundation/geo";
import type { VesselModel } from "./model/vessel";
import { FALLBACK_HULL } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";

/** `POST /route-check`: validates the request, resolves the route and vessel, runs the check. */

export interface RouteServiceDeps {
  index: ChartIndex | undefined;
  indexReason: string | undefined;
  config: PluginConfig;
  vessel(): VesselModel | undefined;
  getRoute(id: string): Promise<unknown>;
  now(): number;
}

async function coordinatesOf(
  req: { coordinates?: LonLat[]; routeId?: string },
  deps: RouteServiceDeps
): Promise<LonLat[] | ApiReply> {
  if (req.coordinates) {
    return req.coordinates;
  }
  const id = req.routeId as string;
  const resource = await deps.getRoute(id).catch(() => undefined);
  const coords = routeResourceCoordinates(resource);
  return coords ?? { status: 404, body: { errors: [`route ${id} not found or has no geometry`] } };
}

function vesselFor(draft: number | undefined, deps: RouteServiceDeps): VesselModel | undefined {
  const current = deps.vessel();
  if (draft === undefined) {
    return current;
  }
  return current ? { ...current, draft } : { draft, ...FALLBACK_HULL };
}

export async function routeCheck(body: unknown, deps: RouteServiceDeps): Promise<ApiReply> {
  const parsed = parseRouteRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: { errors: parsed.errors } };
  }
  if (!deps.index) {
    return { status: 503, body: { errors: [deps.indexReason ?? "no chart index loaded"] } };
  }
  const req = parsed.value;
  const coords = await coordinatesOf(req, deps);
  if (!Array.isArray(coords)) {
    return coords;
  }
  const vessel = vesselFor(req.draft, deps);
  if (!vessel) {
    return { status: 422, body: { errors: ["vessel draft not configured"] } };
  }
  const speeds = speedsFor(req.speed ?? deps.config.routeCheck.speed, coords.length - 1);
  if (typeof speeds === "string") {
    return { status: 400, body: { errors: [speeds] } };
  }
  const result = checkRoute(
    deps.index,
    {
      coordinates: coords,
      departure: req.departure ?? deps.now(),
      speeds,
      xteLimit: req.xteLimit ?? deps.config.routeCheck.xteLimit,
      planningBuffer: deps.config.lookahead.positionBuffer,
      vessel,
      margin: deps.config.lookahead.margin
    },
    deps.now()
  );
  return { status: 200, body: result };
}
