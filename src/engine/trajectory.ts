import type { LonLat } from "../foundation/geo";
import { project } from "../foundation/geo";

/**
 * Constant turn rate and velocity (CTRV) prediction (plan §4.8). Courses
 * are true, radians clockwise from north; a positive rate turns to
 * starboard.
 */

export interface Track {
  course: number;
  /** m/s. */
  sog: number;
  /** Rate of turn, rad/s. */
  rot: number;
  /** The turn lasts this many seconds, then the track runs straight; Infinity by default. */
  turnFor?: number;
}

export interface TrackPoint {
  position: LonLat;
  course: number;
}

/** Below this rate a turn is integrated as a straight line. */
const STRAIGHT_BELOW = 1e-6;

/** East and north offsets after `t` seconds of a constant turn. */
function arc(course: number, sog: number, rot: number, t: number): [number, number] {
  if (Math.abs(rot) < STRAIGHT_BELOW) {
    return [sog * t * Math.sin(course), sog * t * Math.cos(course)];
  }
  const r = sog / rot;
  const end = course + rot * t;
  return [r * (Math.cos(course) - Math.cos(end)), r * (Math.sin(end) - Math.sin(course))];
}

export function trackAt(origin: LonLat, track: Track, t: number): TrackPoint {
  const turning = Math.min(t, track.turnFor ?? Infinity);
  const [e1, n1] = arc(track.course, track.sog, track.rot, turning);
  const course = track.course + track.rot * turning;
  const [e2, n2] = arc(course, track.sog, 0, t - turning);
  const e = e1 + e2;
  const n = n1 + n2;
  const dist = Math.hypot(e, n);
  return { position: dist === 0 ? origin : project(origin, Math.atan2(e, n), dist), course };
}

export interface FanSigma {
  /** 1σ of COG, radians. */
  cog: number;
  /** 1σ of the rate of turn, rad/s. */
  rot: number;
}

/**
 * The M = 5 fan: the central member first, then ROT ± σ and COG ± σ. A
 * rate of turn is held for at most `turnFor` seconds and the track then
 * runs straight: at low speed the horizon reaches minutes, and a turn
 * held that long would sweep the fan across water the boat is not
 * steering for.
 */
export function fanMembers(
  cog: number,
  sog: number,
  rot: number,
  sigma: FanSigma,
  turnFor: number
): Track[] {
  return [
    { course: cog, sog, rot, turnFor },
    { course: cog, sog, rot: rot + sigma.rot, turnFor },
    { course: cog, sog, rot: rot - sigma.rot, turnFor },
    { course: cog + sigma.cog, sog, rot, turnFor },
    { course: cog - sigma.cog, sog, rot, turnFor }
  ];
}

/** A turn of `change` radians at the boat's maximum rate, then straight. */
export function escapeTrack(cog: number, sog: number, change: number, maxRate: number): Track {
  const rot = change === 0 ? 0 : Math.sign(change) * maxRate;
  return { course: cog, sog, rot, turnFor: rot === 0 ? 0 : Math.abs(change) / maxRate };
}
