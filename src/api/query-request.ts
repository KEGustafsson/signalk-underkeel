import type { LonLat } from "../foundation/geo";
import type { Parsed } from "./route-request";

/**
 * Validation of the `POST /query` body: a GeoJSON Point or Polygon (outer
 * ring only), with an optional buffer, draft and speed.
 */

export const QUERY_LIMITS = {
  maxPoints: 500,
  maxBuffer: 2000,
  maxDraft: 30,
  maxSpeed: 30
} as const;

export interface QueryRequest {
  ring: LonLat[];
  bufferMetres?: number;
  draft?: number;
  /** Speed for squat, m/s; 0 when not given. */
  speed?: number;
}

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function position(p: unknown): LonLat | undefined {
  const [lon, lat] = Array.isArray(p) ? (p as unknown[]) : [];
  return inRange(lon, -180, 180) && inRange(lat, -85, 85) ? [lon, lat] : undefined;
}

function parseGeometry(g: unknown, errors: string[]): LonLat[] | undefined {
  const geom = g as { type?: unknown; coordinates?: unknown } | null;
  if (geom?.type === "Point") {
    const p = position(geom.coordinates);
    if (!p) {
      errors.push("point must be [lon, lat] within ±180 / ±85");
    }
    return p && [p];
  }
  if (geom?.type === "Polygon" && Array.isArray(geom.coordinates)) {
    const outer = geom.coordinates[0] as unknown;
    if (!Array.isArray(outer) || outer.length < 4 || outer.length > QUERY_LIMITS.maxPoints) {
      errors.push(`polygon outer ring must have 4..${QUERY_LIMITS.maxPoints} positions`);
      return undefined;
    }
    const ring = outer.map(position);
    if (ring.some((p) => p === undefined)) {
      errors.push("polygon positions must be [lon, lat] within ±180 / ±85");
      return undefined;
    }
    // GeoJSON repeats the first position at the end; the footprint ring does not.
    const r = ring as LonLat[];
    const [first, last] = [r[0] as LonLat, r[r.length - 1] as LonLat];
    return first[0] === last[0] && first[1] === last[1] ? r.slice(0, -1) : r;
  }
  errors.push("geometry must be a GeoJSON Point or Polygon");
  return undefined;
}

export function parseQueryRequest(body: unknown): Parsed<QueryRequest> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const ring = parseGeometry(b.geometry, errors);
  const out: QueryRequest = { ring: ring ?? [] };
  const optional = (key: "bufferMetres" | "draft" | "speed", min: number, max: number) => {
    const v = b[key];
    if (v === undefined) {
      return;
    }
    if (inRange(v, min, max)) {
      out[key] = v;
    } else {
      errors.push(`${key} must be ${min}..${max}`);
    }
  };
  optional("bufferMetres", 0, QUERY_LIMITS.maxBuffer);
  optional("draft", 0.1, QUERY_LIMITS.maxDraft);
  optional("speed", 0, QUERY_LIMITS.maxSpeed);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}
