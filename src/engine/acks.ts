import type { LonLat } from "../foundation/geo";
import type { LookaheadResult, Thresholds } from "./lookahead";

/**
 * Acknowledged passages and mooring zones (plan §4.8, §4.12). Inside one,
 * warn and alarm are published as `alert` with the reason; they are never
 * `normal`. A negative mean UKC within `certainWithin` is never suppressed:
 * an acknowledgement covers an uncertain chart, not a charted depth
 * shallower than the keel.
 */

export interface Ack {
  id: string;
  /** ISO time it was made. */
  created: string;
  /** ISO time it lapses; none when permanent. */
  expires?: string;
  /** Polygon ring in WGS84 without the repeated first point. */
  polygon: LonLat[];
  /** True heading when acknowledged, radians, and the half-width of the sector. */
  heading: number;
  sector: number;
  /** The notification acknowledged, when the client named it. */
  notificationId?: string;
  /** Water level above chart datum and draft when acknowledged, metres. */
  waterLevel: number;
  draft: number;
}

export interface Zone {
  name: string;
  polygon: LonLat[];
}

export interface SuppressionContext {
  acks: readonly Ack[];
  zones: readonly Zone[];
  /** Current true heading, radians. */
  heading: number;
  waterLevel: number;
  draft: number;
  now: number;
  thresholds: Thresholds;
  certainWithin: number;
}

/** The water level may fall this far below the acknowledged one (plan §4.12). */
export const ACK_LEVEL_TOLERANCE = 0.05;

/** Even-odd test in the lon/lat plane, which is enough at passage scale. */
function inside(p: LonLat, ring: readonly LonLat[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as LonLat;
    const b = ring[j] as LonLat;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      c = !c;
    }
  }
  return c;
}

/** The rings of every footprint at or above the alert level, the ones that set the state. */
function riskyRings(result: LookaheadResult, th: Thresholds): LonLat[][] {
  return result.footprints.filter((f) => f.risk >= th.alert || f.uncovered).map((f) => f.ring);
}

function orient(p: LonLat, q: LonLat, r: LonLat): number {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

/** Below this, in degrees, a point is on a line: about 0.01 mm. */
const ON_LINE = 1e-10;

/** Distance from p to the line through c and d, in degrees. */
function lineDistance(p: LonLat, c: LonLat, d: LonLat): number {
  return Math.abs(orient(c, d, p)) / (Math.hypot(d[0] - c[0], d[1] - c[1]) || 1);
}

/**
 * Where along ab, as fractions 0..1, it meets segment cd: the crossing or
 * touching point, or both ends of a collinear overlap.
 */
function contacts(a: LonLat, b: LonLat, c: LonLat, d: LonLat): number[] {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const len2 = rx * rx + ry * ry;
  const den = rx * sy - ry * sx;
  const along = (p: LonLat): number => ((p[0] - a[0]) * rx + (p[1] - a[1]) * ry) / len2;
  const inRange = (t: number): boolean => t >= 0 && t <= 1;
  if (Math.abs(den) <= 1e-12 * Math.sqrt(len2) * Math.hypot(sx, sy)) {
    // Parallel: only a collinear overlap meets ab.
    return lineDistance(c, a, b) <= ON_LINE ? [along(c), along(d)].filter(inRange) : [];
  }
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const slack = 1e-9;
  return t >= -slack && t <= 1 + slack && u >= -slack && u <= 1 + slack
    ? [Math.min(1, Math.max(0, t))]
    : [];
}

function onBoundary(p: LonLat, polygon: readonly LonLat[]): boolean {
  for (let j = 0, l = polygon.length - 1; j < polygon.length; l = j++) {
    const c = polygon[l] as LonLat;
    const d = polygon[j] as LonLat;
    const inBox =
      p[0] >= Math.min(c[0], d[0]) - ON_LINE &&
      p[0] <= Math.max(c[0], d[0]) + ON_LINE &&
      p[1] >= Math.min(c[1], d[1]) - ON_LINE &&
      p[1] <= Math.max(c[1], d[1]) + ON_LINE;
    if (inBox && lineDistance(p, c, d) <= ON_LINE) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the whole ring, edges included, lies in the polygon. Each edge is
 * split wherever it meets the polygon's boundary; between two such points
 * the edge is either all inside or all outside, so the middle of each piece
 * decides. A piece lying on the boundary counts as inside. Vertices alone
 * are not enough: an edge can leave a concave passage between them.
 */
function ringWithin(ring: readonly LonLat[], polygon: readonly LonLat[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as LonLat;
    const b = ring[(i + 1) % ring.length] as LonLat;
    const cuts = [0, 1];
    for (let j = 0, l = polygon.length - 1; j < polygon.length; l = j++) {
      cuts.push(...contacts(a, b, polygon[l] as LonLat, polygon[j] as LonLat));
    }
    cuts.sort((x, y) => x - y);
    for (let k = 1; k < cuts.length; k++) {
      const t0 = cuts[k - 1] as number;
      const t1 = cuts[k] as number;
      if (t1 - t0 <= 1e-12) {
        continue;
      }
      const t = (t0 + t1) / 2;
      const m: LonLat = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      if (!onBoundary(m, polygon) && !inside(m, polygon)) {
        return false;
      }
    }
  }
  return true;
}

function within(rings: LonLat[][], polygon: readonly LonLat[]): boolean {
  return rings.length > 0 && rings.every((ring) => ringWithin(ring, polygon));
}

function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/** Whether `ack` covers the result under the current heading, level and draft. */
export function ackCovers(ack: Ack, rings: LonLat[][], ctx: SuppressionContext): boolean {
  return (
    (ack.expires === undefined || Date.parse(ack.expires) > ctx.now) &&
    angleBetween(ctx.heading, ack.heading) <= ack.sector &&
    ctx.waterLevel >= ack.waterLevel - ACK_LEVEL_TOLERANCE &&
    ctx.draft <= ack.draft &&
    within(rings, ack.polygon)
  );
}

function certain(result: LookaheadResult, certainWithin: number): boolean {
  return result.footprints.some((f) => f.t <= certainWithin && f.mean !== null && f.mean < 0);
}

/** The result to publish once acknowledgements and mooring zones are applied. */
export function suppress(result: LookaheadResult, ctx: SuppressionContext): LookaheadResult {
  if ((result.state !== "warn" && result.state !== "alarm") || certain(result, ctx.certainWithin)) {
    return result;
  }
  const rings = riskyRings(result, ctx.thresholds);
  const zone = ctx.zones.find((z) => within(rings, z.polygon));
  if (zone) {
    return { ...result, state: "alert", reason: `in mooring zone ${zone.name}: ${result.reason}` };
  }
  const ack = ctx.acks.find((a) => ackCovers(a, rings, ctx));
  if (ack) {
    return { ...result, state: "alert", reason: `acknowledged passage: ${result.reason}` };
  }
  return result;
}
