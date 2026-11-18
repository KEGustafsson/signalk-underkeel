import { LIMITS } from "./api/route-request";
import type { ApiReply } from "./api/routes";
import { checkFootprint, checkLeg } from "./engine/route-check";
import type { RouteCheckInput } from "./engine/route-check";
import type { LonLat } from "./foundation/geo";
import { EARTH_RADIUS, haversine } from "./foundation/geo";
import { FALLBACK_HULL } from "./model/vessel";
import type { RouteServiceDeps } from "./route-service";
import { routeCheck } from "./route-service";

/**
 * Planning API v1: the in-process interface signalk-route-planner searches against
 * (its docs/DEVELOPMENT-PLAN.md §2.1). Both plugins run in the Signal K server's Node
 * process; this one registers the object under `PLANNING_API` while it runs, so the
 * planner reads this index, water level and vessel instead of building its own.
 */

export const PLANNING_API = Symbol.for("signalk-underkeel.planning");

export type Status = "ok" | "marginal" | "fail" | "unverified";

export interface Verdict {
  status: Status;
  risk: number;
  flags: string[];
  worst?: LonLat;
}

export interface Window {
  start: number;
  end: number;
}

export interface SessionParams {
  /** Epoch ms. */
  departure: number;
  /** End of the window the verdicts hold for, epoch ms. */
  until: number;
  /** m/s. */
  speed: number;
  xteLimit?: number;
  probability?: number;
  draft?: number;
}

export interface Session {
  /** Corridor half-width: xteLimit + planning buffer, metres. */
  readonly halfWidth: number;
  /** Every point of the box with halfWidth around it, at the lowest level in the window. */
  box(sw: LonLat, ne: LonLat, window?: Window): Verdict;
  /**
   * The leg a → b, checked as /route-check checks a leg, over the window. A leg whose
   * corridor (length plus both ends, times twice halfWidth) is over 25 km² throws RangeError.
   */
  segment(a: LonLat, b: LonLat, window?: Window): Verdict;
  /** Work done so far, in work units (src/engine/work.ts). */
  work(): number;
  /** Yields to the event loop; rejects once the request is aborted. */
  pause(): Promise<void>;
}

export type SessionResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string };

export interface PlanningApiV1 {
  readonly version: 1;
  /** The underkeel release serving it. */
  readonly provider: string;
  /** Why planning cannot run now; undefined when the index is ready. */
  unavailable(): string | undefined;
  /** The box the index covers [west, south, east, north]; undefined for a whole index. */
  coverage(): [number, number, number, number] | undefined;
  defaults(): { speed: number; xteLimit: number; probability: number; planningBuffer: number };
  /** Runs `job` with the index, in the request queue route checks run in. */
  session<T>(
    params: SessionParams,
    signal: AbortSignal,
    job: (s: Session) => Promise<T>
  ): Promise<SessionResult<T>>;
  /** The `/route-check` service: same body, same reply. */
  routeCheck(body: unknown, signal: AbortSignal): Promise<ApiReply>;
}

/**
 * A box's area with its buffer, and a leg's corridor, may be at most this, km²: their
 * queries run without a pause and cost about their area.
 */
export const MAX_BOX_KM2 = 25;

/** sw–ne grown by `r` metres on every side; contains the box's r-buffer. */
export function grownBox(sw: LonLat, ne: LonLat, r: number): LonLat[] {
  const k = Math.PI / 180;
  const dLat = r / (EARTH_RADIUS * k);
  const s = sw[1] - dLat;
  const n = ne[1] + dLat;
  const cos = Math.cos(Math.max(Math.abs(s), Math.abs(n)) * k);
  const dLon = r / (EARTH_RADIUS * k * Math.max(cos, 1e-6));
  const w = sw[0] - dLon;
  const e = ne[0] + dLon;
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n]
  ];
}

function areaKm2(ring: LonLat[]): number {
  const k = Math.PI / 180;
  const [w, s] = ring[0] as LonLat;
  const [e, n] = ring[2] as LonLat;
  const width = (e - w) * k * EARTH_RADIUS * Math.cos(((s + n) / 2) * k);
  return (width * (n - s) * k * EARTH_RADIUS) / 1e6;
}

function pauseFor(signal: AbortSignal): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) =>
      setImmediate(() => (signal.aborted ? reject(signal.reason) : resolve()))
    );
}

const within = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Why `p` cannot start a session, or undefined: the same bounds `/route-check`
 * holds a request to, applied to the values the session would score with.
 */
export function paramsError(
  p: SessionParams,
  probability: number,
  xteLimit: number
): string | undefined {
  if (!Number.isFinite(p.departure) || !Number.isFinite(p.until) || p.until < p.departure) {
    return "departure and until must be finite epoch ms, until not before departure";
  }
  if (!within(p.speed, LIMITS.minSpeed, LIMITS.maxSpeed)) {
    return `speed must be ${LIMITS.minSpeed}..${LIMITS.maxSpeed} m/s`;
  }
  if (!within(xteLimit, 0, LIMITS.maxXte)) {
    return `xteLimit must be 0..${LIMITS.maxXte} m`;
  }
  if (!within(probability, LIMITS.minProbability, LIMITS.maxProbability)) {
    return `probability must be ${LIMITS.minProbability}..${LIMITS.maxProbability}`;
  }
  if (p.draft !== undefined && !within(p.draft, LIMITS.minDraft, LIMITS.maxDraft)) {
    return `draft must be ${LIMITS.minDraft}..${LIMITS.maxDraft} m`;
  }
  return undefined;
}

function inputFor(deps: RouteServiceDeps, p: SessionParams): RouteCheckInput | string {
  const current = deps.vessel();
  const vessel =
    p.draft === undefined
      ? current
      : current
        ? { ...current, draft: p.draft }
        : { draft: p.draft, ...FALLBACK_HULL };
  if (!vessel) {
    return "vessel draft not configured";
  }
  return {
    coordinates: [],
    departure: p.departure,
    speeds: [p.speed],
    xteLimit: p.xteLimit ?? deps.config.routeCheck.xteLimit,
    planningBuffer: deps.config.lookahead.positionBuffer,
    vessel,
    dynamics: deps.config.dynamics,
    waterLevel: deps.waterLevel,
    waveHeight: deps.waveHeight(),
    probability: p.probability ?? deps.config.routeCheck.probability
  };
}

/** A session over the index in use; its verdicts hold for every instant in `window`. */
function sessionFor(
  deps: RouteServiceDeps,
  index: NonNullable<RouteServiceDeps["index"]>,
  input: RouteCheckInput,
  p: SessionParams,
  signal: AbortSignal
): Session {
  const halfWidth = input.xteLimit + input.planningBuffer;
  const whole: Window = { start: p.departure, end: p.until };
  let work = 0;
  return {
    halfWidth,
    box(sw, ne, window = whole) {
      const ring = grownBox(sw, ne, halfWidth);
      if (areaKm2(ring) > MAX_BOX_KM2) {
        throw new RangeError(`box over ${MAX_BOX_KM2} km² with its buffer`);
      }
      const v = checkFootprint(index, input, ring, p.speed, { ...window, at: ring });
      work += v.work;
      return { status: v.status, risk: v.risk, flags: v.flags, worst: v.worst };
    },
    segment(a, b, window = whole) {
      // Its corridor queries run without a pause, so a leg is bounded as a box is.
      if (((haversine(a, b) + 2 * halfWidth) * 2 * halfWidth) / 1e6 > MAX_BOX_KM2) {
        throw new RangeError(`leg corridor over ${MAX_BOX_KM2} km²`);
      }
      // The leg's own level is the window's lowest, whatever its arrival time.
      const leg = { ...input, coordinates: [a, b], waterLevel: () => level(window, [a, b]) };
      const c = checkLeg(index, leg, 0, window.start);
      work += c.work;
      return {
        status: c.leg.status,
        risk: c.leg.risk,
        flags: c.leg.flags,
        worst: c.leg.worst?.position
      };
    },
    work: () => work,
    pause: pauseFor(signal)
  };
  function level(window: Window, at: readonly LonLat[]) {
    return deps.waterLevel(window.start, window.end, at);
  }
}

export function planningApi(deps: () => RouteServiceDeps, provider: string): PlanningApiV1 {
  return {
    version: 1,
    provider,
    unavailable: () => {
      const d = deps();
      return d.index ? undefined : (d.indexReason ?? "no chart index loaded");
    },
    coverage: () => deps().chartBox?.(),
    defaults: () => {
      const c = deps().config;
      return {
        speed: c.routeCheck.speed,
        xteLimit: c.routeCheck.xteLimit,
        probability: c.routeCheck.probability,
        planningBuffer: c.lookahead.positionBuffer
      };
    },
    async session(params, signal, job) {
      const d = deps();
      if (!d.index) {
        return { ok: false, status: 503, error: d.indexReason ?? "no chart index loaded" };
      }
      const bad = paramsError(
        params,
        params.probability ?? d.config.routeCheck.probability,
        params.xteLimit ?? d.config.routeCheck.xteLimit
      );
      if (bad) {
        return { ok: false, status: 400, error: bad };
      }
      const input = inputFor(d, params);
      if (typeof input === "string") {
        return { ok: false, status: 422, error: input };
      }
      const index = d.index;
      const scoped = AbortSignal.any([signal, d.queue.stopSignal]);
      let value: { v: Awaited<ReturnType<typeof job>> } | undefined;
      const reply = await d.queue.run(scoped, async (s) => {
        value = { v: await job(sessionFor(d, index, input, params, s)) };
        return { status: 200, body: null };
      });
      return value && reply.status === 200
        ? { ok: true, value: value.v }
        : { ok: false, status: reply.status, error: errorOf(reply) };
    },
    routeCheck: (body, signal) => routeCheck(body, deps(), signal)
  };
}

function errorOf(reply: ApiReply): string {
  const errors = (reply.body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) && typeof errors[0] === "string" ? errors[0] : "planning failed";
}

type Registry = Record<symbol, PlanningApiV1 | undefined>;

/** Publishes `api` under PLANNING_API; the returned function removes it if it is still ours. */
export function registerPlanningApi(api: PlanningApiV1): () => void {
  const g = globalThis as unknown as Registry;
  g[PLANNING_API] = api;
  return () => {
    if (g[PLANNING_API] === api) {
      delete g[PLANNING_API];
    }
  };
}
