import type { ApiReply } from "./api/routes";
import {
  parseRouteRequest,
  parseWindowOptions,
  routeResourceCoordinates,
  speedsFor,
  windowBudgetError
} from "./api/route-request";
import type { PluginConfig } from "./config";
import { departureWindow } from "./engine/departure-window";
import type { RouteCheckInput } from "./engine/route-check";
import { checkRoute } from "./engine/route-check";
import { DEFAULT_REPAIR, repairRoute } from "./engine/route-repair";
import type { LonLat } from "./foundation/geo";
import type { WaterLevel } from "./model/uncertainty";
import type { VesselModel } from "./model/vessel";
import { FALLBACK_HULL } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";

/** `POST /route-check`: validates the request, resolves the route and vessel, runs the check. */

export interface RouteServiceDeps {
  index: ChartIndex | undefined;
  indexReason: string | undefined;
  config: PluginConfig;
  vessel(): VesselModel | undefined;
  /** Water level over an arrival interval (epoch ms); the lowest applies. */
  waterLevel(start: number, end: number): WaterLevel;
  /** Current significant wave height, if known, metres. */
  waveHeight(): number | undefined;
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

/** Validates the request and resolves route, vessel and speeds into a route-check input. */
async function prepare(
  body: unknown,
  deps: RouteServiceDeps
): Promise<{ index: ChartIndex; input: RouteCheckInput } | ApiReply> {
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
  return {
    index: deps.index,
    input: {
      coordinates: coords,
      departure: req.departure ?? deps.now(),
      speeds,
      xteLimit: req.xteLimit ?? deps.config.routeCheck.xteLimit,
      planningBuffer: deps.config.lookahead.positionBuffer,
      vessel,
      dynamics: deps.config.dynamics,
      waterLevel: deps.waterLevel,
      waveHeight: deps.waveHeight(),
      probability: req.probability ?? deps.config.routeCheck.probability
    }
  };
}

const isReply = (v: unknown): v is ApiReply => typeof (v as ApiReply).status === "number";

/** Lets look-ahead ticks and other requests run between the steps of a long request. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function routeCheck(body: unknown, deps: RouteServiceDeps): Promise<ApiReply> {
  const p = await prepare(body, deps);
  return isReply(p) ? p : { status: 200, body: checkRoute(p.index, p.input, deps.now()) };
}

/** `POST /route-repair`: suggested waypoints for each failing or marginal leg. */
export async function routeRepair(body: unknown, deps: RouteServiceDeps): Promise<ApiReply> {
  const p = await prepare(body, deps);
  if (isReply(p)) {
    return p;
  }
  const checked = checkRoute(p.index, p.input, deps.now());
  const repairs = await repairRoute(
    p.index,
    p.input,
    checked.legs,
    DEFAULT_REPAIR,
    yieldToEventLoop
  );
  return { status: 200, body: { checkedAt: checked.checkedAt, repairs } };
}

/** `POST /departure-window`: departures over the horizon in which every leg is ok. */
export async function departureWindowReply(
  body: unknown,
  deps: RouteServiceDeps
): Promise<ApiReply> {
  const opts = parseWindowOptions(body);
  if (!opts.ok) {
    return { status: 400, body: { errors: opts.errors } };
  }
  const p = await prepare(body, deps);
  if (isReply(p)) {
    return p;
  }
  const budget = windowBudgetError(p.input.coordinates, opts.value);
  if (budget) {
    return { status: 400, body: { errors: [budget] } };
  }
  const from = p.input.departure;
  const result = await departureWindow(
    p.index,
    p.input,
    from,
    from + opts.value.horizon * 1000,
    opts.value.step * 1000,
    yieldToEventLoop
  );
  return { status: 200, body: result };
}
