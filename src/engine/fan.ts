import type { LonLat } from "../foundation/geo";
import { toMercator } from "../foundation/geo";
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

/** The steps a coarse footprint stands for: those after `from`, `step` apart, up to its own. */
export interface Span {
  from: number;
  step: number;
}

/** The span of a footprint scored after `from`, or none for the first. */
export function spanOf(from: number | undefined, step: number): Span | undefined {
  return from === undefined ? undefined : { from, step };
}

/** The step times after `span.from` and before `t`, then `t`. */
function hullTimes(t: number, span: Span | undefined): number[] {
  const out: number[] = [];
  for (let j = 1; span && span.from + j * span.step < t - 1e-9; j++) {
    out.push(span.from + j * span.step);
  }
  out.push(t);
  return out;
}

/**
 * The convex hull of lon/lat points, taken in Mercator, where the chart walk
 * measures: a hull taken in lon/lat bulges past the Mercator straight edges
 * between its points, and left a step's footprint up to 2.5 µm outside a
 * coarse hull at 60° N. Returns the input points themselves, so the walk
 * converts them back to the same Mercator points.
 */
function mercatorHull(points: LonLat[]): LonLat[] {
  const from = new Map<LonLat, LonLat>();
  const merc = points.map((p) => {
    const m = toMercator(p[0], p[1]);
    from.set(m, p);
    return m;
  });
  return convexHull(merc).map((m) => from.get(m) as LonLat);
}

/**
 * Scores the hull of `tracks` at `t`. With `certainStops` the chart walk
 * may end at the first charted land at P = 1; the result is then `partial`.
 * With `span` (a coarse step, plan §4.8) the hull also takes in the
 * footprints of the steps it skipped, so every tile is as near it as to any
 * of theirs: under graded chart position (plan §4.3) a farther tile weighs
 * less, and a hull short of a turn's bulge would read a lower P.
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
  certainStops = false,
  span?: Span
): FootprintResult {
  // The hull keeps its drift angle to the track as the track turns.
  const hullAt = (at: number, track: Track) => {
    const p = trackAt(origin, track, at);
    const heading = m.heading + (p.course - m.cog);
    return {
      center: p.position,
      ring: footprintRing(p.position, heading, lengthAt(at, vessel, opts), vessel.beam)
    };
  };
  const hulls = hullTimes(t, span).flatMap((at) => tracks.map((track) => hullAt(at, track)));
  const center = (hulls[hulls.length - tracks.length] as { center: LonLat }).center;
  const ring =
    hulls.length === 1
      ? (hulls[0] as { ring: LonLat[] }).ring
      : mercatorHull(hulls.flatMap((h) => h.ring));
  const buffer = bufferAt(s, opts);
  const r = minDepthOver(index.pyramid, footprintGeom(ring), {
    bufferMetres: buffer,
    chartPosition: true,
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
