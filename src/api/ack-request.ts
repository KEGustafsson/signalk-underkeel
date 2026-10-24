import type { LonLat } from "../foundation/geo";
import { parsePolygon } from "./query-request";
import type { Parsed } from "./route-request";

/**
 * Validation of the `POST /acks` body (plan §4.12). Everything is
 * optional: without a polygon the current look-ahead area is acknowledged.
 */

export const ACK_LIMITS = {
  minSector: 1,
  maxSector: 90,
  maxTtl: 30 * 86400,
  /**
   * Vertices of an acknowledged polygon. Every warn and alarm tick tests the footprint against
   * each live acknowledgement (at most 100), so a ring is held to what a drawn area needs.
   */
  maxPoints: 64
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

/** The same checks as a `/query` polygon: an unchecked ring would suppress warnings outside it. */
function parseAckPolygon(g: unknown, errors: string[]): LonLat[] | undefined {
  const geom = g as { type?: unknown; coordinates?: unknown } | null;
  if (geom?.type !== "Polygon" || !Array.isArray(geom.coordinates)) {
    errors.push("polygon must be a GeoJSON Polygon");
    return undefined;
  }
  const ring = parsePolygon(geom.coordinates as unknown[], errors);
  if (ring && ring.length > ACK_LIMITS.maxPoints) {
    errors.push(`polygon must have at most ${ACK_LIMITS.maxPoints} vertices`);
    return undefined;
  }
  return ring;
}

export function parseAckRequest(body: unknown): Parsed<AckRequest> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const out: AckRequest = {};
  if (b.polygon !== undefined) {
    out.polygon = parseAckPolygon(b.polygon, errors);
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
