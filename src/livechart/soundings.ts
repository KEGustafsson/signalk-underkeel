import type { LonLat } from "../foundation/geo";
import { project } from "../foundation/geo";
import type { WaterLevel } from "../model/uncertainty";

/**
 * Own soundings (plan §4.13): the quality gate, datum reduction and lever
 * arm correction that turn one echo-sounder reading into a depth below
 * chart datum at the transducer's position.
 */

export interface SoundingSource {
  /** Which Signal K depth path is read. */
  path: "environment.depth.belowSurface" | "environment.depth.belowTransducer";
  /** Transducer depth below the surface, metres; added to belowTransducer readings. */
  transducerDepth: number;
  /** Transducer position from the GNSS antenna, metres forward and to starboard. */
  forward: number;
  starboard: number;
}

export interface RawSounding {
  /** Depth as read from `source.path`, metres. */
  depth: number;
  at: number;
  /** GNSS antenna position. */
  position?: LonLat;
  /** When the position was measured, epoch ms. */
  positionAt?: number;
  /** True heading, radians. */
  heading?: number;
  hdop?: number;
  methodQuality?: string;
  /** Roll, radians. */
  roll?: number;
  waterLevel: WaterLevel;
}

export interface Sounding {
  position: LonLat;
  at: number;
  /** Depth below the surface as measured, metres. */
  belowSurface: number;
  /** Depth below chart datum, metres. */
  depth: number;
  /** 1σ of `depth`, metres. */
  sigma: number;
}

export type Reduced = { ok: true; sounding: Sounding } | { ok: false; reason: string };

const GOOD_FIX = new Set([
  "GNSS Fix",
  "DGNSS fix",
  "Precise GNSS",
  "RTK fixed integer",
  "RTK float"
]);
const MAX_HDOP = 2;
const MAX_ROLL = (15 * Math.PI) / 180;
/** Readings outside this range are sounder errors, not depths. */
const MIN_DEPTH = 0.3;
const MAX_DEPTH = 200;
/**
 * The position may be at most this far in time from the depth reading: at 6 kn a position
 * 10 s old (the staleness limit) is 30 m off, a large part of a 76 m cell.
 */
const MAX_POSITION_SKEW_MS = 2000;

function positionSkew(raw: RawSounding): string | undefined {
  if (raw.positionAt === undefined) {
    return "position time unknown";
  }
  const skew = Math.abs(raw.at - raw.positionAt);
  return skew > MAX_POSITION_SKEW_MS ? `position ${skew} ms from the sounding` : undefined;
}

function gate(raw: RawSounding): string | undefined {
  if (raw.position === undefined) {
    return "no position";
  }
  const skew = positionSkew(raw);
  if (skew) {
    return skew;
  }
  if (raw.methodQuality === undefined || !GOOD_FIX.has(raw.methodQuality)) {
    return `fix quality ${raw.methodQuality ?? "unknown"}`;
  }
  if (raw.hdop === undefined || !(raw.hdop < MAX_HDOP)) {
    return `HDOP ${raw.hdop ?? "unknown"}`;
  }
  if (raw.roll !== undefined && Math.abs(raw.roll) >= MAX_ROLL) {
    return "roll over 15°";
  }
  if (!Number.isFinite(raw.depth) || raw.depth < MIN_DEPTH || raw.depth > MAX_DEPTH) {
    return `depth ${raw.depth} out of range`;
  }
  if (raw.waterLevel.degraded !== undefined) {
    return `water level: ${raw.waterLevel.degraded}`;
  }
  return undefined;
}

/** Applies the quality gate, datum reduction and lever arm; says why a reading is dropped. */
export function reduce(raw: RawSounding, source: SoundingSource): Reduced {
  const reason = gate(raw);
  if (reason) {
    return { ok: false, reason };
  }
  const offset = source.forward !== 0 || source.starboard !== 0;
  if (offset && raw.heading === undefined) {
    return { ok: false, reason: "no heading for the lever arm" };
  }
  let position = raw.position as LonLat;
  if (offset) {
    const h = raw.heading as number;
    position = project(project(position, h, source.forward), h + Math.PI / 2, source.starboard);
  }
  const belowSurface =
    raw.depth + (source.path === "environment.depth.belowTransducer" ? source.transducerDepth : 0);
  return {
    ok: true,
    sounding: {
      position,
      at: raw.at,
      belowSurface,
      depth: belowSurface - raw.waterLevel.h,
      sigma: 0.1 + 0.01 * belowSurface + raw.waterLevel.sigma
    }
  };
}
