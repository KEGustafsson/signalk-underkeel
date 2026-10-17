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

function within(rings: LonLat[][], polygon: readonly LonLat[]): boolean {
  return rings.length > 0 && rings.every((ring) => ring.every((p) => inside(p, polygon)));
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
