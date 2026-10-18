import type { LonLat } from "../foundation/geo";
import type { Parsed } from "./route-request";

/**
 * Validation of the `POST /acks` body (plan §4.12). Everything is
 * optional: without a polygon the current look-ahead area is acknowledged.
 */

export const ACK_LIMITS = {
  maxPoints: 500,
  minSector: 1,
  maxSector: 90,
  maxTtl: 30 * 86400
} as const;

export interface AckRequest {
  polygon?: LonLat[];
  /** Half-width of the heading sector, degrees. */
  sector?: number;
  /** Seconds until the acknowledgement lapses. */
  ttl?: number;
  /** The notification being acknowledged, kept for the record. */
  notificationId?: string;
}

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function parsePolygon(g: unknown, errors: string[]): LonLat[] | undefined {
  const geom = g as { type?: unknown; coordinates?: unknown } | null;
  const outer =
    geom?.type === "Polygon" && Array.isArray(geom.coordinates) ? geom.coordinates[0] : undefined;
  if (!Array.isArray(outer) || outer.length < 4 || outer.length > ACK_LIMITS.maxPoints) {
    errors.push(`polygon must be a GeoJSON Polygon with 4..${ACK_LIMITS.maxPoints} positions`);
    return undefined;
  }
  const ring: LonLat[] = [];
  for (const p of outer as unknown[]) {
    const [lon, lat] = Array.isArray(p) ? (p as unknown[]) : [];
    if (!inRange(lon, -180, 180) || !inRange(lat, -85, 85)) {
      errors.push("polygon positions must be [lon, lat] within ±180 / ±85");
      return undefined;
    }
    ring.push([lon, lat]);
  }
  return ring.slice(0, -1);
}

export function parseAckRequest(body: unknown): Parsed<AckRequest> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const out: AckRequest = {};
  if (b.polygon !== undefined) {
    out.polygon = parsePolygon(b.polygon, errors);
  }
  if (b.sector !== undefined) {
    if (inRange(b.sector, ACK_LIMITS.minSector, ACK_LIMITS.maxSector)) {
      out.sector = b.sector;
    } else {
      errors.push(`sector must be ${ACK_LIMITS.minSector}..${ACK_LIMITS.maxSector} degrees`);
    }
  }
  if (b.ttl !== undefined) {
    if (inRange(b.ttl, 1, ACK_LIMITS.maxTtl)) {
      out.ttl = b.ttl;
    } else {
      errors.push(`ttl must be 1..${ACK_LIMITS.maxTtl} seconds`);
    }
  }
  if (b.notificationId !== undefined) {
    if (typeof b.notificationId === "string" && b.notificationId.length <= 200) {
      out.notificationId = b.notificationId;
    } else {
      errors.push("notificationId must be a string of at most 200 characters");
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}
