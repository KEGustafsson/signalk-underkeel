import type { LonLat } from "../foundation/geo";
import type { VesselTerms } from "../model/uncertainty";
import type { VesselModel } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import { footprintGeom, minDepthOver } from "../spatial/pyramid";
import { convexHull, footprintRing } from "./footprint";
import type { FootprintResult, LookaheadOptions } from "./lookahead";
import type { Track } from "./trajectory";
import { trackAt } from "./trajectory";

/** Scoring of one look-ahead step: the hull of the tracks' footprints against the chart. */

/** Depths deeper than the UKC-zero depth plus this are reported as a lower bound. */
export const CLEARANCE_RESOLUTION = 5;

export interface Motion {
  known: boolean;
  moving: boolean;
  cog: number;
  sog: number;
  /** Rate of turn, rad/s; 0 when not published or stale. */
  rot: number;
  heading: number;
  horizon: number;
}

export interface Scoring {
  terms: VesselTerms;
  threshold: number;
  sigmaExtra: number;
  /** 1σ position uncertainty now, metres. */
  sigmaPos: number;
}

/**
 * The most k_p · σ_pos widens a footprint, metres (decision, plan §4.8). A
 * 2 km GNSS jump set σ_pos to 2 km, and each tick then read the chart 4 km
 * around every footprint for 1.5 s; beyond this the state is at least warn.
 */
export const MAX_POSITION_BUFFER = 500;

/** Ground buffer around every footprint: k_p · σ_pos, never below the configured floor. */
export function bufferAt(s: Scoring, opts: LookaheadOptions): number {
  const floor = opts.positionBuffer;
  return Math.max(floor, Math.min(opts.kp * s.sigmaPos, MAX_POSITION_BUFFER));
}

/** k_p · σ_pos exceeds the buffer the footprints get. */
export function bufferCapped(s: Scoring, opts: LookaheadOptions): boolean {
  return opts.kp * s.sigmaPos > bufferAt(s, opts);
}

/**
 * Hull length at `t` seconds ahead. Speed error moves the boat along its
 * track, so its k_p · σ_SOG · t spread lengthens the footprint fore and
 * aft; across the track the fan members carry the spread.
 */
export function lengthAt(t: number, vessel: VesselModel, opts: LookaheadOptions): number {
  return vessel.length + 2 * opts.kp * opts.sigmaSog * t;
}

/**
 * Scores the hull of `tracks` at `t`. With `certainStops` the chart walk
 * may end at the first charted land at P = 1; the result is then `partial`.
 */
export function footprint(
  t: number,
  origin: LonLat,
  tracks: Track[],
  m: Motion,
  vessel: VesselModel,
  index: ChartIndex,
  s: Scoring,
  opts: LookaheadOptions,
  certainStops = false
): FootprintResult {
  // The hull keeps its drift angle to the track as the track turns.
  const hulls = tracks.map((track) => {
    const p = trackAt(origin, track, t);
    const heading = m.heading + (p.course - m.cog);
    return {
      center: p.position,
      ring: footprintRing(p.position, heading, lengthAt(t, vessel, opts), vessel.beam)
    };
  });
  const center = (hulls[0] as { center: LonLat }).center;
  const ring =
    hulls.length === 1
      ? (hulls[0] as { ring: LonLat[] }).ring
      : convexHull(hulls.flatMap((h) => h.ring));
  const buffer = bufferAt(s, opts);
  const r = minDepthOver(index.pyramid, footprintGeom(ring), {
    bufferMetres: buffer,
    chartReachK: opts.kp,
    clearAbove: s.threshold + CLEARANCE_RESOLUTION,
    risk: { threshold: s.threshold, sigmaExtra: s.sigmaExtra },
    stopWhenCertain: certainStops
  });
  // A query that visited no tile (a degenerate footprint) proved nothing.
  const examined = r.visits > 0;
  const charted = !examined || r.coveredDMin === Infinity ? null : r.coveredDMin;
  return {
    t,
    center,
    ring,
    buffer,
    charted,
    mean: charted === null ? null : charted - s.threshold,
    sigma: r.riskTile ? Math.hypot(r.riskTile.sigmaD, s.sigmaExtra) : s.sigmaExtra,
    risk: r.maxRisk,
    uncovered: !examined || (r.flags & FLAGS.NO_COVERAGE) !== 0,
    flags: r.flags,
    sigmaP: r.sigmaP,
    riskTile: r.riskTile,
    partial: certainStops && r.maxRisk >= 1 && r.coveredDMin === -Infinity && r.dMin === -Infinity
  };
}
