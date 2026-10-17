import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";

/**
 * Validation of the `POST /route-check` body (plan §4.11). Everything a
 * client sends is checked against hard limits before it reaches the
 * engine, so a malformed or oversized request costs a 400, not CPU.
 */

export const LIMITS = {
  maxPoints: 1000,
  /**
   * Total route length, metres. The check runs one corridor query per
   * kilometre on the event loop, so this bounds what one request costs.
   */
  maxRouteMetres: 500_000,
  minSpeed: 0.1,
  maxSpeed: 30,
  maxXte: 2000,
  minDraft: 0.01,
  maxDraft: 30,
  minProbability: 1e-6,
  maxProbability: 0.5
} as const;

export interface RouteRequest {
  /** Inline geometry, when given. */
  coordinates?: LonLat[];
  /** `/resources/routes/<id>`, when given instead of geometry. */
  routeId?: string;
  departure?: number;
  /** Either one speed for every leg or one per leg, m/s. */
  speed?: number | number[];
  xteLimit?: number;
  draft?: number;
  /** Accept threshold for P(UKC < 0). */
  probability?: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function inRange(v: unknown, min: number, max: number): v is number {
  return isNum(v) && v >= min && v <= max;
}

function parseCoordinates(route: unknown, errors: string[]): LonLat[] | undefined {
  const r = route as { type?: unknown; coordinates?: unknown };
  if (r?.type !== "LineString" || !Array.isArray(r.coordinates)) {
    errors.push("route must be a GeoJSON LineString");
    return undefined;
  }
  if (r.coordinates.length < 2 || r.coordinates.length > LIMITS.maxPoints) {
    errors.push(`route must have 2..${LIMITS.maxPoints} points`);
    return undefined;
  }
  const out: LonLat[] = [];
  for (const p of r.coordinates as unknown[]) {
    const [lon, lat] = Array.isArray(p) ? (p as unknown[]) : [];
    if (!inRange(lon, -180, 180) || !inRange(lat, -85, 85)) {
      errors.push("route coordinates must be [lon, lat] within ±180 / ±85");
      return undefined;
    }
    out.push([lon, lat]);
  }
  let total = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1] as LonLat;
    const b = out[i] as LonLat;
    // The chart index has no longitude wrap: a leg across ±180° would be
    // checked over a corridor spanning the globe.
    if (Math.abs(b[0] - a[0]) > 180) {
      errors.push("route legs must not cross the ±180° meridian");
      return undefined;
    }
    total += haversine(a, b);
  }
  if (total > LIMITS.maxRouteMetres) {
    errors.push(`route must be at most ${LIMITS.maxRouteMetres / 1000} km long`);
    return undefined;
  }
  return out;
}

const ROUTE_REF = /^\/resources\/routes\/([A-Za-z0-9._:-]{1,128})$/;

function parseSpeed(raw: unknown, errors: string[]): number | number[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const ok = (v: unknown) => inRange(v, LIMITS.minSpeed, LIMITS.maxSpeed);
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as {
    default?: unknown;
    legs?: unknown;
  };
  const candidate = Array.isArray(raw) ? raw : isNum(raw) ? raw : (s.legs ?? s.default);
  if (Array.isArray(candidate) ? candidate.every(ok) : ok(candidate)) {
    return candidate as number | number[];
  }
  errors.push(`speed must be ${LIMITS.minSpeed}..${LIMITS.maxSpeed} m/s`);
  return undefined;
}

function parseDeparture(raw: unknown, errors: string[]): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(t)) {
    errors.push("departure must be an ISO 8601 time");
    return undefined;
  }
  return t;
}

export function parseRouteRequest(body: unknown): Parsed<RouteRequest> {
  const errors: string[] = [];
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const req: RouteRequest = {};
  if (b.route !== undefined) {
    req.coordinates = parseCoordinates(b.route, errors);
  } else if (typeof b.routeRef === "string" && ROUTE_REF.test(b.routeRef)) {
    req.routeId = (ROUTE_REF.exec(b.routeRef) as RegExpExecArray)[1];
  } else {
    errors.push("give route (GeoJSON LineString) or routeRef (/resources/routes/<id>)");
  }
  req.departure = parseDeparture(b.departure, errors);
  req.speed = parseSpeed(b.speed, errors);
  if (b.xteLimit !== undefined) {
    if (inRange(b.xteLimit, 0, LIMITS.maxXte)) {
      req.xteLimit = b.xteLimit;
    } else {
      errors.push(`xteLimit must be 0..${LIMITS.maxXte} m`);
    }
  }
  if (b.probability !== undefined) {
    if (inRange(b.probability, LIMITS.minProbability, LIMITS.maxProbability)) {
      req.probability = b.probability;
    } else {
      errors.push(`probability must be ${LIMITS.minProbability}..${LIMITS.maxProbability}`);
    }
  }
  const draft = (b.vessel as { draft?: unknown } | undefined)?.draft;
  if (draft !== undefined) {
    if (inRange(draft, LIMITS.minDraft, LIMITS.maxDraft)) {
      req.draft = draft;
    } else {
      errors.push(`vessel.draft must be ${LIMITS.minDraft}..${LIMITS.maxDraft} m`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: req };
}

/** Speeds per leg from a single value or a per-leg list; errors when the list length is wrong. */
export function speedsFor(speed: number | number[], legs: number): number[] | string {
  if (!Array.isArray(speed)) {
    return Array.from({ length: legs }, () => speed);
  }
  return speed.length === legs ? speed : `speed has ${speed.length} values for ${legs} legs`;
}

/** Coordinates of a Signal K route resource, or undefined if it has none. */
export function routeResourceCoordinates(resource: unknown): LonLat[] | undefined {
  const r = resource as { feature?: { geometry?: unknown } } | undefined;
  const errors: string[] = [];
  const coords = parseCoordinates(r?.feature?.geometry, errors);
  return errors.length === 0 ? coords : undefined;
}

export const WINDOW_LIMITS = {
  defaultHorizon: 48 * 3600,
  maxHorizon: 7 * 86400,
  defaultStep: 15 * 60,
  minStep: 5 * 60,
  maxSteps: 1000
} as const;

/** `horizon` and `step` of a departure-window request, seconds. */
export function parseWindowOptions(body: unknown): Parsed<{ horizon: number; step: number }> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const horizon = b.horizon ?? WINDOW_LIMITS.defaultHorizon;
  const step = b.step ?? WINDOW_LIMITS.defaultStep;
  const errors: string[] = [];
  if (!inRange(horizon, 0, WINDOW_LIMITS.maxHorizon)) {
    errors.push(`horizon must be 0..${WINDOW_LIMITS.maxHorizon} s`);
  }
  if (!inRange(step, WINDOW_LIMITS.minStep, WINDOW_LIMITS.maxHorizon)) {
    errors.push(`step must be at least ${WINDOW_LIMITS.minStep} s`);
  }
  if (errors.length === 0 && (horizon as number) / (step as number) > WINDOW_LIMITS.maxSteps) {
    errors.push(`horizon / step must be at most ${WINDOW_LIMITS.maxSteps} departures`);
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { horizon: horizon as number, step: step as number } };
}
