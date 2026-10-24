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
  /** The turn starts this many seconds along the track, which runs straight until then; 0 by default. */
  turnAfter?: number;
  /** A rate added to `rot` for its first `for` seconds: the fan's ROT spread over an escape turn. */
  spread?: { rot: number; for: number };
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
  // The rate is constant between the start and end of the turn and the end of the spread.
  const from = Math.min(t, track.turnAfter ?? 0);
  const to = Math.min(t, from + (track.turnFor ?? Infinity));
  const spreading = Math.min(t, track.spread?.for ?? 0);
  let e = 0;
  let n = 0;
  let course = track.course;
  let at = 0;
  for (const end of [from, to, spreading, t].sort((a, b) => a - b)) {
    const turn = at >= from && at < to ? track.rot : 0;
    const rate = turn + (at < spreading ? (track.spread?.rot ?? 0) : 0);
    const [de, dn] = arc(course, track.sog, rate, end - at);
    e += de;
    n += dn;
    course += rate * (end - at);
    at = end;
  }
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

/**
 * A turn of `change` radians at the boat's maximum rate, then straight. The
 * turn starts `after` seconds along the track: a track that starts at an
 * earlier position fix cannot turn before now.
 */
export function escapeTrack(
  cog: number,
  sog: number,
  change: number,
  maxRate: number,
  after = 0
): Track {
  const rot = change === 0 ? 0 : Math.sign(change) * maxRate;
  const track = { course: cog, sog, rot, turnFor: rot === 0 ? 0 : Math.abs(change) / maxRate };
  return after > 0 ? { ...track, turnAfter: after } : track;
}

/**
 * An escape heading's fan: its escape track, then the same with the fan's
 * spread laid over it, ROT ± σ for `turnFor` seconds and COG ± σ. A heading
 * scored on its track alone is narrower than the fan that raised the state,
 * and holding course could pass clear of a shoal a COG ± σ member hits.
 * Every member turns `after` seconds along, as `escapeTrack` does.
 */
export function escapeMembers(
  cog: number,
  sog: number,
  change: number,
  maxRate: number,
  sigma: FanSigma,
  turnFor: number,
  after = 0
): Track[] {
  const track = escapeTrack(cog, sog, change, maxRate, after);
  return [
    track,
    { ...track, spread: { rot: sigma.rot, for: turnFor } },
    { ...track, spread: { rot: -sigma.rot, for: turnFor } },
    { ...track, course: cog + sigma.cog },
    { ...track, course: cog - sigma.cog }
  ];
}
