import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Sounding } from "./soundings";

/**
 * The boat's own passages (plan §4.13, the planner's R4c): the accepted soundings joined into
 * tracks where they follow each other closely in time and space, each with the highest water
 * level it was sailed at. A planner keeps to a track only at water no lower than that, so a
 * track lowers cost, never risk (invariant 6).
 */

export interface OwnTrack {
  coordinates: LonLat[];
  /** The highest water level above chart datum while it was sailed, metres. */
  level: number;
}

/** Soundings further apart than this in time start a new track, ms. */
const GAP_MS = 120_000;
/** ...or further apart than this, metres: a position jump is not a passage. */
const GAP_METRES = 200;
/** A track keeps a point at most this often, metres: soundings come every second. */
const STEP_METRES = 25;

/** The water level a sounding was taken at: its depth below the surface less below datum. */
const levelOf = (s: Sounding): number => s.belowSurface - s.depth;

/** The tracks of `samples`, oldest first; a track of a single point is none. */
export function tracksOf(samples: readonly Sounding[]): OwnTrack[] {
  const out: OwnTrack[] = [];
  let cur: OwnTrack | undefined;
  let prev: Sounding | undefined;
  for (const s of samples) {
    const joins =
      prev !== undefined &&
      s.at - prev.at <= GAP_MS &&
      s.at >= prev.at &&
      haversine(prev.position, s.position) <= GAP_METRES;
    if (!cur || !joins) {
      if (cur && cur.coordinates.length >= 2) {
        out.push(cur);
      }
      cur = { coordinates: [s.position], level: levelOf(s) };
    } else {
      const last = cur.coordinates[cur.coordinates.length - 1] as LonLat;
      if (haversine(last, s.position) >= STEP_METRES) {
        cur.coordinates.push(s.position);
      }
      cur.level = Math.max(cur.level, levelOf(s));
    }
    prev = s;
  }
  if (cur && cur.coordinates.length >= 2) {
    out.push(cur);
  }
  return out;
}
