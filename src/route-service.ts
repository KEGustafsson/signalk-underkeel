import type { ApiReply } from "./api/routes";
import {
  corridorBudgetError,
  parseRouteRequest,
  parseWindowOptions,
  routeResourceCoordinates,
  speedsFor,
  windowBudgetError
} from "./api/route-request";
import type { PluginConfig } from "./config";
import { departureWindow } from "./engine/departure-window";
import type { RouteCheckInput } from "./engine/route-check";
import { checkRouteYielding } from "./engine/route-check";
import { explainOutsideBox } from "./engine/chart-box";
import { DEFAULT_REPAIR, repairRoute } from "./engine/route-repair";
import type { LonLat } from "./foundation/geo";
import type { Bbox } from "./ingest/wfs";
import type { WaterLevel } from "./model/uncertainty";
import type { VesselModel } from "./model/vessel";
import { FALLBACK_HULL } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";

/** `POST /route-check`, `/route-repair` and `/departure-window`: validation, then the work in a queue. */

export interface RouteServiceDeps {
  index: ChartIndex | undefined;
  indexReason: string | undefined;
  config: PluginConfig;
  vessel(): VesselModel | undefined;
  /** Water level over an arrival interval (epoch ms) at the positions `at`; the lowest applies. */
  waterLevel(start: number, end: number, at: readonly LonLat[]): WaterLevel;
  /** Current significant wave height, if known, metres. */
  waveHeight(): number | undefined;
  getRoute(id: string): Promise<unknown>;
  now(): number;
  queue: RequestQueue;
  /** The box the index in use was built in around the vessel; none for a whole index. */
  chartBox?: () => Bbox | undefined;
}

/**
 * The route lookup, given up when the request's signal aborts first. The provider gets no
 * signal, so its lookup runs on; only the request stops waiting for it.
 */
function lookup(deps: RouteServiceDeps, id: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    deps
      .getRoute(id)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function coordinatesOf(
  req: { coordinates?: LonLat[]; routeId?: string },
  deps: RouteServiceDeps,
  signal: AbortSignal
): Promise<LonLat[] | ApiReply> {
  if (req.coordinates) {
    return req.coordinates;
  }
  const id = req.routeId as string;
  if (signal.aborted) {
    return aborted(signal);
  }
  const resource = await lookup(deps, id, signal).catch(() => undefined);
  if (signal.aborted) {
    return aborted(signal);
  }
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
  deps: RouteServiceDeps,
  signal: AbortSignal
): Promise<{ index: ChartIndex; input: RouteCheckInput } | ApiReply> {
  const parsed = parseRouteRequest(body, deps.now());
  if (!parsed.ok) {
    return { status: 400, body: { errors: parsed.errors } };
  }
  if (!deps.index) {
    return { status: 503, body: { errors: [deps.indexReason ?? "no chart index loaded"] } };
  }
  const req = parsed.value;
  const coords = await coordinatesOf(req, deps, signal);
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
  const xteLimit = req.xteLimit ?? deps.config.routeCheck.xteLimit;
  const planningBuffer = deps.config.lookahead.positionBuffer;
  const budget = corridorBudgetError(coords, xteLimit + planningBuffer);
  if (budget) {
    return { status: 400, body: { errors: [budget] } };
  }
  return {
    index: deps.index,
    input: {
      coordinates: coords,
      departure: req.departure ?? deps.now(),
      speeds,
      xteLimit,
      planningBuffer,
      vessel,
      dynamics: deps.config.dynamics,
      waterLevel: deps.waterLevel,
      waveHeight: deps.waveHeight(),
      probability: req.probability ?? deps.config.routeCheck.probability
    }
  };
}

const isReply = (v: unknown): v is ApiReply => typeof (v as ApiReply).status === "number";

/** Requests the queue holds beside the one running; more are refused. */
export const MAX_WAITING = 4;

/**
 * One request's heavy work at a time (route check, repair, departure
 * window, query), at most MAX_WAITING more in line and the rest refused
 * with 503. Each job runs with a signal that aborts when its client goes
 * away or the plugin stops; it is checked at every pause, so an abandoned
 * request stops within one slice and never answers with a partial result.
 */
export class RequestQueue {
  private running = false;
  private readonly waiting: (() => void)[] = [];
  private stopped = new AbortController();

  /**
   * Aborts on the next `abortAll`. A request takes it before any awaited work, so a stop
   * while it still prepares (a route fetched by reference) reaches it too.
   */
  get stopSignal(): AbortSignal {
    return this.stopped.signal;
  }

  /** Aborts the running and every waiting job; later jobs run as usual. */
  abortAll(reason: string): void {
    this.stopped.abort(new Error(reason));
    this.stopped = new AbortController();
  }

  async run(
    client: AbortSignal,
    job: (signal: AbortSignal) => Promise<ApiReply>
  ): Promise<ApiReply> {
    const signal = AbortSignal.any([client, this.stopped.signal]);
    if (this.running && this.waiting.length >= MAX_WAITING) {
      return {
        status: 503,
        body: { errors: [`busy: ${MAX_WAITING} requests are waiting; try again shortly`] },
        headers: { "Retry-After": "2" }
      };
    }
    if (this.running && !(await this.turn(signal))) {
      return aborted(signal);
    }
    this.running = true;
    try {
      signal.throwIfAborted();
      return await job(signal);
    } catch (err) {
      if (signal.aborted) {
        return aborted(signal);
      }
      throw err;
    } finally {
      // The next job inherits `running`, so a request arriving now cannot run beside it.
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.running = false;
      }
    }
  }

  /** True when this job's turn comes, false when its signal aborts first. */
  private turn(signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const start = () => resolve(true);
      this.waiting.push(start);
      signal.addEventListener(
        "abort",
        () => {
          const i = this.waiting.indexOf(start);
          if (i >= 0) {
            this.waiting.splice(i, 1);
            resolve(false);
          }
        },
        { once: true }
      );
    });
  }
}

function aborted(signal: AbortSignal): ApiReply {
  return { status: 503, body: { errors: [abortReason(signal)] } };
}

/** For callers whose work no client can abandon. */
const NEVER = new AbortController().signal;

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "request aborted";
}

/**
 * Lets look-ahead ticks and other requests run between the steps of a long
 * request, and ends the request there once its signal aborts.
 */
function pauseFor(signal: AbortSignal): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) =>
      setImmediate(() => (signal.aborted ? reject(signal.reason) : resolve()))
    );
}

export async function routeCheck(
  body: unknown,
  deps: RouteServiceDeps,
  client: AbortSignal = NEVER
): Promise<ApiReply> {
  const scoped = AbortSignal.any([client, deps.queue.stopSignal]);
  const p = await prepare(body, deps, scoped);
  if (isReply(p)) {
    return p;
  }
  const halfWidth = p.input.xteLimit + p.input.planningBuffer;
  return deps.queue.run(scoped, async (signal) => ({
    status: 200,
    body: explainOutsideBox(
      await checkRouteYielding(p.index, p.input, deps.now(), pauseFor(signal)),
      deps.chartBox?.(),
      halfWidth
    )
  }));
}

/** `POST /route-repair`: suggested waypoints for each failing or marginal leg. */
export async function routeRepair(
  body: unknown,
  deps: RouteServiceDeps,
  client: AbortSignal = NEVER
): Promise<ApiReply> {
  const scoped = AbortSignal.any([client, deps.queue.stopSignal]);
  const p = await prepare(body, deps, scoped);
  if (isReply(p)) {
    return p;
  }
  return deps.queue.run(scoped, async (signal) => {
    const checkedAt = new Date(deps.now()).toISOString();
    const { repairs, route } = await repairRoute(
      p.index,
      p.input,
      DEFAULT_REPAIR,
      pauseFor(signal)
    );
    return { status: 200, body: { checkedAt, repairs, route } };
  });
}

/** `POST /departure-window`: departures over the horizon in which every leg is ok. */
export async function departureWindowReply(
  body: unknown,
  deps: RouteServiceDeps,
  client: AbortSignal = NEVER
): Promise<ApiReply> {
  const scoped = AbortSignal.any([client, deps.queue.stopSignal]);
  const opts = parseWindowOptions(body);
  if (!opts.ok) {
    return { status: 400, body: { errors: opts.errors } };
  }
  const p = await prepare(body, deps, scoped);
  if (isReply(p)) {
    return p;
  }
  const budget = windowBudgetError(
    p.input.coordinates,
    opts.value,
    p.input.xteLimit + p.input.planningBuffer
  );
  if (budget) {
    return { status: 400, body: { errors: [budget] } };
  }
  const from = p.input.departure;
  const to = from + opts.value.horizon * 1000;
  return deps.queue.run(scoped, async (signal) => ({
    status: 200,
    body: await departureWindow(
      p.index,
      p.input,
      from,
      to,
      opts.value.step * 1000,
      pauseFor(signal)
    )
  }));
}
