import type { LonLat } from "../foundation/geo";
import { project, tileSize } from "../foundation/geo";
import { geomBounds } from "../foundation/geometry";
import type { UnderKeelState } from "../foundation/state";
import type { RollRange } from "../model/allowances";
import { RollWindow } from "../model/allowances";
import type { VesselTerms, WaterLevel } from "../model/uncertainty";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import { gnssSigma } from "../model/position";
import type { DynamicsOptions, VesselModel } from "../model/vessel";
import { vesselTerms } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { chartReach } from "../spatial/chart-position";
import { flagNames } from "../spatial/node-store";
import type { RiskTile } from "../spatial/pyramid";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { Explanation } from "./explain";
import { explain, sentence } from "./explain";
import { escapeHeading } from "./escape";
import type { Motion, Scoring } from "./fan";
import { footprint } from "./fan";
import { fanMembers } from "./trajectory";
import { classify, degrade } from "./verdict";

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
  /** Recent roll samples; each evaluation adds `roll` to it. Without it only `roll` counts. */
  rolls?: RollWindow;
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

/** Configurable maxima: each footprint costs a chart query every tick. */
export const LOOKAHEAD_LIMITS = { distance: 5 * 1852, minHorizon: 600 } as const;

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
  /** True heading with the longest time to shoal, radians; null when normal or none is better. */
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

/**
 * Footprints per tick at most. Footprints a step apart still touch up to
 * reach / SOG, so a long horizon at low speed takes longer steps rather
 * than more footprints; only when that is not enough is the horizon cut.
 */
export const MAX_FOOTPRINTS = 400;

function timesFor(m: Motion, vessel: VesselModel, opts: LookaheadOptions): number[] {
  const gapFree = m.sog > 0 ? (vessel.length + 2 * opts.positionBuffer) / m.sog : opts.step;
  const step = Math.min(
    gapFree,
    Math.max(stepFor(m.sog, vessel, opts), m.horizon / (MAX_FOOTPRINTS - 1))
  );
  const horizon = Math.min(m.horizon, step * (MAX_FOOTPRINTS - 1));
  const n = Math.ceil(horizon / step - 1e-9);
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    times.push(i * step);
  }
  times.push(horizon);
  return times;
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
  wl: WaterLevel,
  kp: number
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
  // tile, which counts k_p·σP beyond the buffer, so the naming search looks
  // that far out. Only a hazard whose depth is the tile's depth is named:
  // it is the one that set it.
  const geom = footprintGeom(worst.ring);
  const leafDiagonal =
    tileSize(index.pyramid.leafZoom) * Math.cos((worst.center[1] * Math.PI) / 180) * Math.SQRT2;
  const reach =
    worst.buffer + DEFAULT_BUILD.k * worst.sigmaP + chartReach(kp, worst.sigmaP) + leafDiagonal;
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

/** The |roll| range heel may use; undefined when roll is stale or not published. */
function rollOf(nav: NavState, now: number, opts: LookaheadOptions): RollRange | undefined {
  if (stale(nav.roll, now, opts)) {
    return undefined;
  }
  const r = nav.roll as Sample<number>;
  const window = nav.rolls ?? new RollWindow();
  window.record(r.value, r.at);
  return window.range(now);
}

/** A navigation state that keeps the roll window across evaluations. */
export function navState(): NavState {
  return { rolls: new RollWindow() };
}

function scoringFor(
  nav: NavState,
  inputs: LookaheadInputs,
  vessel: VesselModel,
  now: number,
  opts: LookaheadOptions
): Scoring {
  const fresh = <T>(x: Sample<T> | undefined): T | undefined =>
    stale(x, now, opts) ? undefined : x?.value;
  // Squat follows speed through the water, and a stale COG does not stop the hull sinking.
  const squatSpeed = Math.max(fresh(nav.sog) ?? 0, fresh(nav.stw) ?? 0);
  const terms = vesselTerms(
    vessel,
    { speed: squatSpeed, roll: rollOf(nav, now, opts), waveHeight: nav.waveHeight?.value },
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
  const s = scoringFor(nav, inputs, vessel, now, opts);
  const origin = nav.position.value;
  const times = timesFor(m, vessel, opts);
  const tracks = fanMembers(
    m.cog,
    m.sog,
    m.rot,
    { cog: opts.sigmaCog, rot: opts.sigmaRot },
    opts.turnFor
  );
  const fps = times.map((t) =>
    footprint(t, origin, tracks, m, vessel, index, s, opts, t <= opts.warnWithin)
  );
  const verdict = degrade(classify(fps, opts), m, wl, fps);
  const escape =
    inputs.escape === true && m.moving && verdict.state !== "normal" && verdict.state !== "unknown"
      ? escapeHeading(times, origin, m, vessel, index, s, opts)
      : null;
  const shallowest = shallowestOf(fps);
  return {
    state: verdict.state,
    reason: verdict.reason,
    // Over land the mean is -Infinity: there is no clearance to report, and the state says why.
    clearance: shallowest && Number.isFinite(shallowest.mean) ? shallowest.mean : null,
    clearanceSigma: shallowest ? shallowest.sigma : null,
    risk: fps.reduce<number | null>((max, f) => Math.max(max ?? 0, f.risk), null),
    timeToShoal: verdict.tts,
    escapeHeading: escape,
    horizon: times[times.length - 1] as number,
    footprints: fps,
    worst: worstOf(fps, index, s, wl, opts.kp),
    waterLevel: wl
  };
}

/** One-line explanation of the worst point, for notification messages. */
export function describe(result: LookaheadResult): string {
  const w = result.worst;
  return w ? `${result.reason}: ${sentence(w.explanation)}` : result.reason;
}
