import type { LonLat } from "../foundation/geo";
import { project, tileSize } from "../foundation/geo";
import { geomBounds } from "../foundation/geometry";
import type { UnderKeelState } from "../foundation/state";
import type { VesselTerms, WaterLevel } from "../model/uncertainty";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import { gnssSigma } from "../model/position";
import type { DynamicsOptions, VesselModel } from "../model/vessel";
import { vesselTerms } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS, flagNames } from "../spatial/node-store";
import type { RiskTile } from "../spatial/pyramid";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { Explanation } from "./explain";
import { explain, sentence } from "./explain";
import { escapeHeading } from "./escape";
import type { Motion, Scoring } from "./fan";
import { footprint } from "./fan";
import { fanMembers } from "./trajectory";

/**
 * Look-ahead (plan §4.7–§4.8): a CTRV fan of five tracks from COG, SOG and
 * rate of turn. At each step the hull of the five hull footprints, grown by
 * k_p · σ_pos(t), is scored by P(UKC < 0) from the charted depth and its
 * survey σ, the water level, draft, squat, heel and wave allowance. Scoring
 * the hull rather than each member also covers the water between members.
 * Stale or missing input, and a degraded water-level source, never yield
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
  /** Rate of turn, rad/s, positive to starboard. */
  rot?: Sample<number>;
  /** GNSS horizontal dilution of precision. */
  hdop?: Sample<number>;
  /** Speed through water, m/s, for the integrity check. */
  stw?: Sample<number>;
  /** `navigation.gnss.methodQuality`, for the integrity check. */
  methodQuality?: Sample<string>;
  /** Roll, radians. */
  roll?: Sample<number>;
  /** Significant wave height, metres. */
  waveHeight?: Sample<number>;
}

/** P(UKC < 0) levels of the state table (plan §4.7). */
export interface Thresholds {
  alert: number;
  warn: number;
  alarm: number;
}

export interface LookaheadOptions {
  /** Look-ahead distance D in metres; horizon H = max(minHorizon, D / SOG). */
  distance: number;
  minHorizon: number;
  /** Seconds between footprints. */
  step: number;
  /** Least ground buffer around every footprint, metres. */
  positionBuffer: number;
  /** The buffer is max(positionBuffer, kp · σ_pos(t)). */
  kp: number;
  /** Fan spread: 1σ of COG (radians) and of the rate of turn (rad/s). */
  sigmaCog: number;
  sigmaRot: number;
  /** Along-track speed 1σ, m/s: footprints lengthen by k_p times this per second ahead. */
  sigmaSog: number;
  /** A rate of turn is held this many seconds ahead, then the fan runs straight. */
  turnFor: number;
  /** The boat's maximum rate of turn for escape arcs, rad/s. */
  maxTurnRate: number;
  /** Escape headings are tried every `escapeStep` out to ±`escapeMax`, radians. */
  escapeStep: number;
  escapeMax: number;
  /** Inputs older than this (seconds) are stale. */
  staleAfter: number;
  /** Below this SOG (m/s) only the current position is checked. */
  lowSpeed: number;
  thresholds: Thresholds;
  /** P ≥ warn within this many seconds raises warn. */
  warnWithin: number;
  /** P ≥ alarm within this many seconds raises alarm. */
  alarmWithin: number;
  /** A negative mean UKC within this many seconds raises alarm whatever P is. */
  certainWithin: number;
}

export const DEFAULT_LOOKAHEAD: LookaheadOptions = {
  distance: 0.3 * 1852,
  minHorizon: 60,
  step: 3,
  positionBuffer: 10,
  kp: 2,
  sigmaCog: (5 * Math.PI) / 180,
  sigmaRot: (0.1 * Math.PI) / 180,
  sigmaSog: 0.1,
  turnFor: 60,
  maxTurnRate: (3 * Math.PI) / 180,
  escapeStep: (5 * Math.PI) / 180,
  escapeMax: (90 * Math.PI) / 180,
  staleAfter: 10,
  lowSpeed: 0.5 * (1852 / 3600),
  thresholds: { alert: 0.01, warn: 0.05, alarm: 0.2 },
  warnWithin: 120,
  alarmWithin: 60,
  certainWithin: 30
};

export interface FootprintResult {
  /** Seconds from now. */
  t: number;
  /** Position of the central member. */
  center: LonLat;
  ring: LonLat[];
  /** Ground buffer the footprint was grown by, metres. */
  buffer: number;
  /** Shallowest charted depth over the covered part; null when nothing is charted. */
  charted: number | null;
  /** Mean UKC at the shallowest charted depth, metres; null when nothing is charted. */
  mean: number | null;
  /** σ of the UKC at the riskiest tile, metres. */
  sigma: number;
  /** Highest per-tile P(UKC < 0). */
  risk: number;
  /** Part of the footprint has no chart coverage. */
  uncovered: boolean;
  flags: number;
  /** Widest source σP the footprint touched, metres. */
  sigmaP: number;
  riskTile?: RiskTile;
}

export interface WorstPoint {
  t: number;
  position: LonLat;
  explanation: Explanation;
}

export interface LookaheadResult {
  state: UnderKeelState;
  /** Why the engine is in this state; empty only for a clean `normal`. */
  reason: string;
  /** Minimum mean UKC over the horizon, metres; null when not computed. */
  clearance: number | null;
  /** σ of `clearance`, from the same footprint, metres; null when not computed. */
  clearanceSigma: number | null;
  /** Highest P(UKC < 0) over the horizon; null when not computed. */
  risk: number | null;
  /** Seconds until P first reaches the warn level; null if it does not. */
  timeToShoal: number | null;
  /** True heading with the longest time to shoal, radians; null when normal. */
  escapeHeading: number | null;
  horizon: number;
  footprints: FootprintResult[];
  worst?: WorstPoint;
  waterLevel?: WaterLevel;
}

export interface LookaheadInputs {
  vessel: VesselModel | undefined;
  dynamics: DynamicsOptions;
  waterLevel: WaterLevel;
  /** 1σ position uncertainty now, metres; from HDOP when not given. */
  positionSigma?: number;
  /** Search the escape fan when not normal; it costs up to 37 extra tracks. */
  escape?: boolean;
}

function stale(sample: Sample<unknown> | undefined, now: number, opts: LookaheadOptions): boolean {
  return sample === undefined || now - sample.at > opts.staleAfter * 1000;
}

function degraded(state: UnderKeelState, reason: string): LookaheadResult {
  return {
    state,
    reason,
    clearance: null,
    clearanceSigma: null,
    risk: null,
    timeToShoal: null,
    escapeHeading: null,
    horizon: 0,
    footprints: []
  };
}

function motionOf(nav: NavState, now: number, opts: LookaheadOptions): Motion {
  const known = !stale(nav.cog, now, opts) && !stale(nav.sog, now, opts);
  const sog = known ? (nav.sog as Sample<number>).value : 0;
  const cog = known ? (nav.cog as Sample<number>).value : 0;
  const heading = stale(nav.heading, now, opts) ? cog : (nav.heading as Sample<number>).value;
  const rot = stale(nav.rot, now, opts) ? 0 : (nav.rot as Sample<number>).value;
  const moving = known && sog >= opts.lowSpeed;
  const horizon = moving ? Math.max(opts.minHorizon, opts.distance / sog) : 0;
  return { known, moving, cog, sog, rot, heading, horizon };
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

function timesFor(m: Motion, vessel: VesselModel, opts: LookaheadOptions): number[] {
  const times: number[] = [];
  const step = stepFor(m.sog, vessel, opts);
  for (let t = 0; t < m.horizon; t += step) {
    times.push(t);
  }
  times.push(m.horizon);
  return times;
}

interface Verdict {
  state: UnderKeelState;
  reason: string;
  tts: number | null;
}

const inS = (t: number): string => `${t.toFixed(0)} s`;

function classify(fps: FootprintResult[], opts: LookaheadOptions): Verdict {
  const th = opts.thresholds;
  const alarm = fps.find(
    (f) =>
      (f.t <= opts.alarmWithin && f.risk >= th.alarm) ||
      (f.t <= opts.certainWithin && f.mean !== null && f.mean < 0)
  );
  const warn = fps.find((f) => f.risk >= th.warn);
  const tts = warn ? warn.t : null;
  if (alarm) {
    const reason = alarm.t === 0 ? "shoal under the vessel" : `shoal ahead in ${inS(alarm.t)}`;
    return { state: "alarm", reason, tts: tts ?? alarm.t };
  }
  if (warn && tts !== null && tts <= opts.warnWithin) {
    // At a coverage edge the risk comes from the gap's unassessed σ, so say so.
    const gap = ((warn.riskTile?.flags ?? 0) & FLAGS.NO_COVERAGE) !== 0;
    const what = gap ? "no chart coverage" : "shoal";
    return { state: "warn", reason: `${what} ahead in ${inS(tts)}`, tts };
  }
  const uncovered = fps.find((f) => f.uncovered);
  if (uncovered) {
    const where = uncovered.t === 0 ? "at the vessel" : `ahead in ${inS(uncovered.t)}`;
    return { state: "warn", reason: `no chart coverage ${where}`, tts };
  }
  const alert = fps.find((f) => f.risk >= th.alert);
  if (alert) {
    return { state: "alert", reason: `shoal risk ahead in ${inS(alert.t)}`, tts };
  }
  return { state: "normal", reason: "", tts: null };
}

/**
 * A clear answer is downgraded when it rests on less than full input:
 * without course and speed only the vessel's own footprint is checked
 * (`unknown`), and a fallback water level is published as an alert.
 */
function degrade(c: Verdict, m: Motion, wl: WaterLevel): Verdict {
  if (c.state !== "normal") {
    return c;
  }
  if (!m.known) {
    return {
      ...c,
      state: "unknown",
      reason: "course or speed stale: only the current position is checked"
    };
  }
  if (wl.degraded) {
    return { ...c, state: "alert", reason: wl.degraded };
  }
  if (!m.moving) {
    return { ...c, reason: "low speed: only the current position is checked" };
  }
  return c;
}

function riskiest(fps: FootprintResult[]): FootprintResult | undefined {
  let worst: FootprintResult | undefined;
  for (const f of fps) {
    if (f.charted === null) {
      continue;
    }
    const better =
      worst === undefined ||
      f.risk > worst.risk ||
      (f.risk === worst.risk && (f.mean as number) < (worst.mean as number));
    if (better) {
      worst = f;
    }
  }
  return worst;
}

function worstOf(
  fps: FootprintResult[],
  index: ChartIndex,
  s: Scoring,
  wl: WaterLevel
): WorstPoint | undefined {
  const worst = riskiest(fps);
  if (!worst) {
    return undefined;
  }
  const tile = worst.riskTile ?? {
    dMin: worst.charted as number,
    sigmaD: 0,
    cellRef: -1,
    flags: worst.flags
  };
  // A hazard reaches k·σP from its position and then fills its whole leaf
  // tile, so the naming search looks that far out. Only a hazard whose depth
  // is the tile's depth is named: it is the one that set it.
  const geom = footprintGeom(worst.ring);
  const leafDiagonal =
    tileSize(index.pyramid.leafZoom) * Math.cos((worst.center[1] * Math.PI) / 180) * Math.SQRT2;
  const reach = worst.buffer + DEFAULT_BUILD.k * worst.sigmaP + leafDiagonal;
  const hit = index.hazards
    .near(geom, mercatorBuffer(geomBounds(geom), reach))
    .find((h) => h.feature.depth === tile.dMin);
  const cell = index.catalogue.cells[tile.cellRef];
  const explanation = explain(
    tile,
    {
      flags: flagNames(tile.flags),
      cell: cell && { name: cell.name, edition: cell.edition, update: cell.update },
      hazard: hit && {
        class: hit.feature.objectClass,
        lnam: hit.feature.lnam,
        depth: hit.feature.depth
      }
    },
    s.terms,
    wl
  );
  return { t: worst.t, position: worst.riskTile?.center ?? worst.center, explanation };
}

function finiteNav(nav: NavState): boolean {
  const p = nav.position?.value;
  return (
    p !== undefined &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    [nav.cog, nav.sog, nav.heading, nav.rot, nav.hdop, nav.roll, nav.waveHeight].every(
      (s) => s === undefined || Number.isFinite(s.value)
    )
  );
}

/**
 * The footprint with the lowest mean UKC, so clearance and its σ come from
 * one footprint; between equally shallow ones the wider σ is reported.
 */
function shallowestOf(fps: FootprintResult[]): FootprintResult | undefined {
  let best: FootprintResult | undefined;
  for (const f of fps) {
    if (f.mean === null) {
      continue;
    }
    const b = best?.mean as number;
    if (best === undefined || f.mean < b || (f.mean === b && f.sigma > best.sigma)) {
      best = f;
    }
  }
  return best;
}

function scoringFor(
  nav: NavState,
  inputs: LookaheadInputs,
  vessel: VesselModel,
  m: Motion,
  now: number,
  opts: LookaheadOptions
): Scoring {
  const fresh = <T>(x: Sample<T> | undefined): T | undefined =>
    stale(x, now, opts) ? undefined : x?.value;
  const terms = vesselTerms(
    vessel,
    { speed: m.sog, roll: fresh(nav.roll), waveHeight: nav.waveHeight?.value },
    inputs.dynamics
  );
  const wl = inputs.waterLevel;
  return {
    terms,
    threshold: thresholdDepth(terms, wl),
    sigmaExtra: sigmaExtra(terms, wl),
    sigmaPos: inputs.positionSigma ?? gnssSigma(fresh(nav.hdop))
  };
}

export function evaluateLookahead(
  nav: NavState,
  inputs: LookaheadInputs,
  index: ChartIndex | undefined,
  now: number,
  opts: LookaheadOptions = DEFAULT_LOOKAHEAD
): LookaheadResult {
  if (!index) {
    return degraded("off", "no chart index loaded");
  }
  const vessel = inputs.vessel;
  if (!vessel) {
    return degraded("unknown", "vessel draft not configured");
  }
  if (!nav.position) {
    return degraded("unknown", "no position");
  }
  if (stale(nav.position, now, opts)) {
    return degraded("unknown", "position stale");
  }
  if (!finiteNav(nav)) {
    return degraded("unknown", "non-finite navigation input");
  }
  const m = motionOf(nav, now, opts);
  const wl = inputs.waterLevel;
  const s = scoringFor(nav, inputs, vessel, m, now, opts);
  const origin = nav.position.value;
  const times = timesFor(m, vessel, opts);
  const tracks = fanMembers(
    m.cog,
    m.sog,
    m.rot,
    { cog: opts.sigmaCog, rot: opts.sigmaRot },
    opts.turnFor
  );
  const fps = times.map((t) => footprint(t, origin, tracks, m, vessel, index, s, opts));
  const verdict = degrade(classify(fps, opts), m, wl);
  const escape =
    inputs.escape === true && m.moving && verdict.state !== "normal" && verdict.state !== "unknown"
      ? escapeHeading(times, origin, m, vessel, index, s, opts)
      : null;
  const shallowest = shallowestOf(fps);
  return {
    state: verdict.state,
    reason: verdict.reason,
    clearance: shallowest ? shallowest.mean : null,
    clearanceSigma: shallowest ? shallowest.sigma : null,
    risk: fps.length > 0 ? Math.max(...fps.map((f) => f.risk)) : null,
    timeToShoal: verdict.tts,
    escapeHeading: escape,
    horizon: m.horizon,
    footprints: fps,
    worst: worstOf(fps, index, s, wl),
    waterLevel: wl
  };
}

/** One-line explanation of the worst point, for notification messages. */
export function describe(result: LookaheadResult): string {
  const w = result.worst;
  return w ? `${result.reason}: ${sentence(w.explanation)}` : result.reason;
}
