import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Parsed } from "./route-request";

/**
 * Validation of the `POST /query` body: a GeoJSON Point or Polygon (outer
 * ring only), with an optional buffer, draft and speed.
 */

export const QUERY_LIMITS = {
  maxPoints: 500,
  maxBuffer: 2000,
  maxDraft: 30,
  maxSpeed: 30,
  /**
   * Polygon bounding-box diagonal, metres. The query walks every pyramid
   * tile under the box on the event loop, so this bounds its cost.
   */
  maxPolygonMetres: 50_000
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

/** The ring's bounding box is at most maxPolygonMetres across; a box across ±180° is not. */
function withinSpan(ring: LonLat[]): boolean {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const sw: LonLat = [Math.min(...lons), Math.min(...lats)];
  const ne: LonLat = [Math.max(...lons), Math.max(...lats)];
  return ne[0] - sw[0] <= 180 && haversine(sw, ne) <= QUERY_LIMITS.maxPolygonMetres;
}

/** The closed outer ring of a GeoJSON Polygon, without the repeated closing position. */
export function parsePolygon(rings: unknown[], errors: string[]): LonLat[] | undefined {
  if (rings.length > 1) {
    // A hole would be queried as part of the polygon.
    errors.push("polygon holes are not supported");
    return undefined;
  }
  const outer = rings[0] as unknown;
  if (!Array.isArray(outer) || outer.length < 4 || outer.length > QUERY_LIMITS.maxPoints) {
    errors.push(`polygon outer ring must have 4..${QUERY_LIMITS.maxPoints} positions`);
    return undefined;
  }
  const ring = outer.map(position);
  if (ring.some((p) => p === undefined)) {
    errors.push("polygon positions must be [lon, lat] within ±180 / ±85");
    return undefined;
  }
  const r = ring as LonLat[];
  if (!withinSpan(r)) {
    errors.push(`polygon must fit in a box ${QUERY_LIMITS.maxPolygonMetres / 1000} km across`);
    return undefined;
  }
  // GeoJSON (RFC 7946) repeats the first position at the end; the footprint ring does not.
  const [first, last] = [r[0] as LonLat, r[r.length - 1] as LonLat];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    errors.push("polygon outer ring must be closed");
    return undefined;
  }
  return r.slice(0, -1);
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
    return parsePolygon(geom.coordinates as unknown[], errors);
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
