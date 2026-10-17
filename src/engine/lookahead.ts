import type { LonLat } from "../foundation/geo";
import { project, tileSize } from "../foundation/geo";
import type { UnderKeelState } from "../foundation/state";
import type { CellInfo } from "../ingest/cells";
import type { VesselModel } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import { geomBounds } from "../foundation/geometry";
import { footprintRing } from "./footprint";

/**
 * Deterministic look-ahead (milestone M1): a straight cone along COG,
 * checked every `step` seconds against the chart with a fixed safety
 * margin. Water level is chart datum. Stale or missing input never yields
 * `normal` (safety invariant 3).
 */

export interface Sample<T> {
  value: T;
  /** Epoch milliseconds of the measurement. */
  at: number;
}

export interface NavState {
  position?: Sample<LonLat>;
  /** Course over ground, true, radians. */
  cog?: Sample<number>;
  /** Speed over ground, m/s. */
  sog?: Sample<number>;
  /** Heading, true, radians. */
  heading?: Sample<number>;
}

export interface LookaheadOptions {
  /** Look-ahead distance D in metres; horizon H = max(minHorizon, D / SOG). */
  distance: number;
  minHorizon: number;
  /** Seconds between footprints. */
  step: number;
  /** Ground buffer added to every footprint for position uncertainty, metres. */
  positionBuffer: number;
  /** The cone widens by tan(halfAngle) per metre run, radians. */
  coneHalfAngle: number;
  /** Fixed safety margin under the keel, metres. */
  margin: number;
  /** Inputs older than this (seconds) are stale. */
  staleAfter: number;
  /** Below this SOG (m/s) only the current position is checked. */
  lowSpeed: number;
  /** A shoal within this many seconds raises warn. */
  warnWithin: number;
  /** A shoal within this many seconds raises alarm. */
  alarmWithin: number;
}

export const DEFAULT_LOOKAHEAD: LookaheadOptions = {
  distance: 0.3 * 1852,
  minHorizon: 60,
  step: 3,
  positionBuffer: 10,
  coneHalfAngle: (5 * Math.PI) / 180,
  margin: 0.5,
  staleAfter: 10,
  lowSpeed: 0.5 * (1852 / 3600),
  warnWithin: 120,
  alarmWithin: 30
};

/** Depths deeper than draft + margin + this are reported as a lower bound. */
const CLEARANCE_RESOLUTION = 5;

export interface FootprintResult {
  /** Seconds from now. */
  t: number;
  center: LonLat;
  ring: LonLat[];
  dMin: number;
  /** Charted depth minus draft and margin over the covered part; null when nothing is covered. */
  ukc: number | null;
  /** Part of the footprint has no chart coverage. */
  uncovered: boolean;
  flags: number;
  cellRef: number;
  /** Widest source σP the footprint touched, metres. */
  sigmaP: number;
}

export interface WorstPoint {
  t: number;
  position: LonLat;
  charted: number;
  ukc: number;
  cell?: Pick<CellInfo, "name" | "edition" | "update">;
  hazard?: { class: string; lnam?: string; depth: number };
}

export interface LookaheadResult {
  state: UnderKeelState;
  /** Why the engine is in this state; empty only for a clean `normal`. */
  reason: string;
  /** Minimum UKC over the horizon, metres; null when not computed. */
  clearance: number | null;
  /** Seconds until the first footprint with UKC < 0; null if none. */
  timeToShoal: number | null;
  horizon: number;
  footprints: FootprintResult[];
  worst?: WorstPoint;
  draft?: number;
  margin?: number;
}

function stale(sample: Sample<unknown> | undefined, now: number, opts: LookaheadOptions): boolean {
  return sample === undefined || now - sample.at > opts.staleAfter * 1000;
}

function degraded(state: UnderKeelState, reason: string): LookaheadResult {
  return { state, reason, clearance: null, timeToShoal: null, horizon: 0, footprints: [] };
}

interface Track {
  origin: LonLat;
  cog: number;
  sog: number;
  heading: number;
  horizon: number;
}

/**
 * Seconds between footprints. The plan's Δt applies at ordinary speeds; a
 * fast boat would leave gaps between Δt-spaced hulls, so the step shrinks
 * until consecutive footprints (hull length plus the buffer at both ends)
 * still touch.
 */
export function stepFor(sog: number, vessel: VesselModel, opts: LookaheadOptions): number {
  const reach = vessel.length + 2 * opts.positionBuffer;
  return sog > 0 ? Math.min(opts.step, reach / sog) : opts.step;
}

function footprints(
  track: Track,
  vessel: VesselModel,
  index: ChartIndex,
  opts: LookaheadOptions
): FootprintResult[] {
  const out: FootprintResult[] = [];
  const clearAbove = vessel.draft + opts.margin + CLEARANCE_RESOLUTION;
  const times: number[] = [];
  const step = stepFor(track.sog, vessel, opts);
  for (let t = 0; t < track.horizon; t += step) {
    times.push(t);
  }
  times.push(track.horizon);
  for (const t of times) {
    const run = track.sog * t;
    const center = t === 0 ? track.origin : project(track.origin, track.cog, run);
    const width = vessel.beam + 2 * run * Math.tan(opts.coneHalfAngle);
    const ring = footprintRing(center, track.heading, vessel.length, width);
    const r = minDepthOver(index.pyramid, footprintGeom(ring), {
      bufferMetres: opts.positionBuffer,
      clearAbove
    });
    const charted = r.coveredDMin !== Infinity;
    out.push({
      t,
      center,
      ring,
      dMin: r.coveredDMin,
      ukc: charted ? r.coveredDMin - vessel.draft - opts.margin : null,
      uncovered: (r.flags & FLAGS.NO_COVERAGE) !== 0,
      flags: r.flags,
      cellRef: r.cellRef,
      sigmaP: r.sigmaP
    });
  }
  return out;
}

function worstOf(
  fps: FootprintResult[],
  index: ChartIndex,
  opts: LookaheadOptions
): WorstPoint | undefined {
  let worst: FootprintResult | undefined;
  for (const f of fps) {
    if (f.ukc !== null && (worst === undefined || f.ukc < (worst.ukc as number))) {
      worst = f;
    }
  }
  if (worst === undefined || worst.ukc === null) {
    return undefined;
  }
  // A hazard reaches k·σP from its position and then fills its whole leaf
  // tile, so the naming search looks that far out. It only picks the name;
  // the depth already came from the pyramid.
  const geom = footprintGeom(worst.ring);
  const leafDiagonal =
    tileSize(index.pyramid.leafZoom) * Math.cos((worst.center[1] * Math.PI) / 180) * Math.SQRT2;
  const reach = opts.positionBuffer + DEFAULT_BUILD.k * worst.sigmaP + leafDiagonal;
  const hit = index.hazards
    .near(geom, mercatorBuffer(geomBounds(geom), reach))
    .find((h) => h.feature.depth <= worst.dMin);
  const cell = index.catalogue.cells[worst.cellRef];
  return {
    t: worst.t,
    position: worst.center,
    charted: worst.dMin,
    ukc: worst.ukc,
    cell: cell && { name: cell.name, edition: cell.edition, update: cell.update },
    hazard: hit && {
      class: hit.feature.objectClass,
      lnam: hit.feature.lnam,
      depth: hit.feature.depth
    }
  };
}

function fmt(m: number): string {
  return Number.isFinite(m) ? `${m.toFixed(1)} m` : "land";
}

function classify(
  fps: FootprintResult[],
  opts: LookaheadOptions
): { state: UnderKeelState; reason: string; tts: number | null } {
  const shoal = fps.find((f) => f.ukc !== null && f.ukc < 0);
  const uncovered = fps.find((f) => f.uncovered);
  const tts = shoal ? shoal.t : null;
  if (tts !== null && tts <= opts.alarmWithin) {
    return {
      state: "alarm",
      reason: tts === 0 ? "shoal under the vessel" : `shoal ahead in ${tts.toFixed(0)} s`,
      tts
    };
  }
  if (tts !== null && tts <= opts.warnWithin) {
    return { state: "warn", reason: `shoal ahead in ${tts.toFixed(0)} s`, tts };
  }
  if (uncovered) {
    const where = uncovered.t === 0 ? "at the vessel" : `ahead in ${uncovered.t.toFixed(0)} s`;
    return { state: "warn", reason: `no chart coverage ${where}`, tts };
  }
  if (tts !== null) {
    return { state: "alert", reason: `shoal ahead in ${tts.toFixed(0)} s`, tts };
  }
  return { state: "normal", reason: "", tts: null };
}

interface Motion {
  known: boolean;
  moving: boolean;
  cog: number;
  sog: number;
  heading: number;
  horizon: number;
}

function motionOf(nav: NavState, now: number, opts: LookaheadOptions): Motion {
  const known = !stale(nav.cog, now, opts) && !stale(nav.sog, now, opts);
  const sog = known ? (nav.sog as Sample<number>).value : 0;
  const cog = known ? (nav.cog as Sample<number>).value : 0;
  const heading = stale(nav.heading, now, opts) ? cog : (nav.heading as Sample<number>).value;
  const moving = known && sog >= opts.lowSpeed;
  const horizon = moving ? Math.max(opts.minHorizon, opts.distance / sog) : 0;
  return { known, moving, cog, sog, heading, horizon };
}

/**
 * Without course and speed only the vessel's own footprint is checked, so a
 * clear answer is reported as `unknown`, never `normal`.
 */
function degradeForMotion(
  c: { state: UnderKeelState; reason: string },
  m: Motion
): { state: UnderKeelState; reason: string } {
  if (c.state !== "normal") {
    return c;
  }
  if (!m.known) {
    return {
      state: "unknown",
      reason: "course or speed stale: only the current position is checked"
    };
  }
  if (!m.moving) {
    return { state: "normal", reason: "low speed: only the current position is checked" };
  }
  return c;
}

export function evaluateLookahead(
  nav: NavState,
  vessel: VesselModel | undefined,
  index: ChartIndex | undefined,
  now: number,
  opts: LookaheadOptions = DEFAULT_LOOKAHEAD
): LookaheadResult {
  if (!index) {
    return degraded("off", "no chart index loaded");
  }
  if (!vessel) {
    return degraded("unknown", "vessel draft not configured");
  }
  if (!nav.position) {
    return degraded("unknown", "no position");
  }
  if (stale(nav.position, now, opts)) {
    return degraded("unknown", "position stale");
  }
  const m = motionOf(nav, now, opts);
  const fps = footprints({ origin: nav.position.value, ...m }, vessel, index, opts);
  const c = classify(fps, opts);
  const ukcs = fps.map((f) => f.ukc).filter((u): u is number => u !== null);
  const { state, reason } = degradeForMotion(c, m);
  return {
    state,
    reason,
    clearance: ukcs.length > 0 ? Math.min(...ukcs) : null,
    timeToShoal: c.tts,
    horizon: m.horizon,
    footprints: fps,
    worst: worstOf(fps, index, opts),
    draft: vessel.draft,
    margin: opts.margin
  };
}

/** One-line explanation of the worst point, for notification messages. */
export function describe(result: LookaheadResult): string {
  const w = result.worst;
  if (!w || result.draft === undefined || result.margin === undefined) {
    return result.reason;
  }
  const hazard = w.hazard ? ` (${w.hazard.class}${w.hazard.lnam ? ` ${w.hazard.lnam}` : ""})` : "";
  return (
    `${result.reason}: charted ${fmt(w.charted)}${hazard} − draft ${fmt(result.draft)}` +
    ` − margin ${fmt(result.margin)} → UKC ${fmt(w.ukc)}`
  );
}
