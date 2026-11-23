import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import { geomBounds } from "../foundation/geometry";
import type { VesselTerms, WaterLevel } from "../model/uncertainty";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import type { DynamicsOptions, VesselModel } from "../model/vessel";
import { vesselTerms } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS, flagNames } from "../spatial/node-store";
import type { DepthResult, RiskTile } from "../spatial/pyramid";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { Explanation } from "./explain";
import { explainTile } from "./explain";
import { bearing, legCorridors, rhumbCourse } from "./corridor";
import { heldDepth, stripHolding } from "./gap-strips";
import type { LegDepth, Scoring } from "./leg-depth";
import { bridgedSteps, CLEARANCE_RESOLUTION, corridorSteps } from "./leg-depth";
import { applyRules } from "./rule-check";

export { corridorRing, legCorridors, RING_REACH } from "./corridor";
import { queryWork } from "./work";

/**
 * Corridor route check (plan §4.11): each leg is checked over
 * `buffer(leg, xteLimit + planning buffer)`, and scored by the highest
 * per-tile P(UKC < 0) in that corridor with the leg's squat and the water
 * level at its arrival. A leg whose corridor touches missing coverage or an
 * unassessed survey is `unverified`, never `ok` (safety invariant 4).
 */

export type LegStatus = "ok" | "marginal" | "fail" | "unverified";

export interface RouteCheckInput {
  coordinates: LonLat[];
  /** Epoch milliseconds of departure from the first point. */
  departure: number;
  /** Speed per leg in m/s; one value per leg. */
  speeds: number[];
  /** Allowed cross-track error, metres. */
  xteLimit: number;
  /**
   * What the corridor reaches past the cross-track limit, metres: half the hull's beam
   * (`model/vessel.ts`, `hullBuffer`). No position buffer: the GPS is the look-ahead's.
   */
  hullBuffer: number;
  vessel: VesselModel;
  dynamics: DynamicsOptions;
  /**
   * Water level over the arrival interval [start, end] (epoch ms) at the
   * positions `at`, a leg's two ends; the worst one is used. With `area`, `at`
   * is a convex ring and the level holds for every point inside it too.
   */
  waterLevel(start: number, end: number, at: readonly LonLat[], area?: boolean): WaterLevel;
  /**
   * The highest water level over [start, end] at `at`, as `waterLevel` takes the lowest: what
   * a bridge's clearance is held to (`rule-check.ts`). Absent, a clearance that depends on the
   * water level is unverified.
   */
  highWater?(start: number, end: number, at: readonly LonLat[], area?: boolean): WaterLevel;
  /** Significant wave height to allow for, metres. */
  waveHeight?: number;
  /** Accept threshold: a leg is ok below this P(UKC < 0). */
  probability: number;
}

export interface LegResult {
  index: number;
  status: LegStatus;
  from: LonLat;
  to: LonLat;
  /** Leg length, metres. */
  length: number;
  /** Arrival at the leg's start and end points, ISO 8601. */
  eta: { start: string; end: string };
  /** Mean UKC at the shallowest charted depth, metres; null when nothing is charted or land. */
  minUkc: number | null;
  /** σ of the UKC at the riskiest tile, metres. */
  sigma: number;
  /** Highest per-tile P(UKC < 0) in the corridor. */
  risk: number;
  /** Shallowest charted depth in the corridor, metres; null for land or nothing charted. */
  charted: number | null;
  flags: string[];
  worst?: {
    position: LonLat;
    hazard?: { class: string; lnam?: string; valsou: number | null };
  };
  explanation?: Explanation;
  /** Why the leg is unverified, when the flags alone do not say (`chart-box.ts`). */
  reason?: string;
}

export interface RouteCheckResult {
  checkedAt: string;
  charts: { cell: string; edition: number; update: number }[];
  waterLevelSource: string;
  /** Set when the water level over the route is a fallback, with the reason. */
  waterLevelDegraded?: string;
  legs: LegResult[];
}

/** A check split at its corridor queries, so a caller can let other work in between them. */
export type Steps<T> = Generator<void, T, void>;

export function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) {
      return r.value;
    }
  }
}

/** P at or above this fails a leg whatever the accepted probability. */
const FAIL_RISK = 0.5;

/** Flags that leave a corridor unchecked: such a leg is never `ok` (safety invariant 4). */
export const UNCHECKED =
  FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

function statusOf(risk: number, charted: number | null, flags: number, p: number): LegStatus {
  if (risk >= Math.min(5 * p, Math.max(p, FAIL_RISK))) {
    return "fail";
  }
  if (charted === null || flags & UNCHECKED) {
    return "unverified";
  }
  return risk >= p ? "marginal" : "ok";
}

function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

interface CheckedLeg {
  leg: LegResult;
  cellRefs: number[];
  /** Work its corridor queries did (work.ts). */
  work: number;
}

export function checkLeg(
  index: ChartIndex,
  input: RouteCheckInput,
  i: number,
  start: number
): CheckedLeg {
  return drain(legSteps(index, input, i, start));
}

function* legSteps(
  index: ChartIndex,
  input: RouteCheckInput,
  i: number,
  start: number
): Steps<CheckedLeg> {
  const from = input.coordinates[i] as LonLat;
  const to = input.coordinates[i + 1] as LonLat;
  const length = haversine(from, to);
  const speed = input.speeds[i] as number;
  const end = start + (length / speed) * 1000;
  const wl = input.waterLevel(start, end, [from, to]);
  const { terms, s } = scoringFor(input, speed, wl);
  const width = input.xteLimit + input.hullBuffer;
  const { result, ring, work, strip } = yield* heldSteps(index, [from, to], width, s);
  const covered = result.coveredDMin;
  const land = covered === -Infinity;
  const charted = covered === Infinity || land ? null : covered;
  const flags = flagNames(result.flags);
  if (land) {
    flags.push("LAND");
  }
  if (strip) {
    flags.push(FAIRWAY_GAP_FLAG);
  }
  const tile = result.riskTile;
  const why = tile ? explainTile(index, tile, ring, terms, wl) : undefined;
  const rings = legCorridors(from, to, width);
  const course = rhumbCourse(from, to);
  const status = applyRules(
    verdictStatus(result.maxRisk, charted, result.flags, land, wl, flags, input),
    { index, input, flags },
    { rings, start, end, at: [from, to], course }
  );
  const leg: LegResult = {
    index: i,
    status,
    from,
    to,
    length: Math.round(length),
    eta: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    minUkc: charted === null ? null : finiteOrNull(charted - s.threshold),
    sigma: finiteOrNull(tile ? Math.hypot(tile.sigmaD, s.sigmaExtra) : s.sigmaExtra) ?? 0,
    risk: Math.round(result.maxRisk * 10000) / 10000,
    charted: charted === null ? null : finiteOrNull(charted),
    flags,
    worst: tile && { position: tile.center, hazard: why?.hazard },
    explanation: why?.explanation
  };
  return { leg, cellRefs: result.cellRefs, work };
}

/** The flag of a leg or box held to a fairway gap strip (`gap-strips.ts`). */
export const FAIRWAY_GAP_FLAG = "FAIRWAY_GAP";

/** Flags of tiles a sweep or dredging covers: only then can a swept-only reading pass. */
const SWEPT_BITS = FLAGS.SWEPT | FLAGS.DREDGED;

/**
 * A leg's corridor `width` metres each side, read three ways where they apply, the lowest risk
 * standing: through the index; in swept or dredged water all through (`QueryOptions.sweptOnly`,
 * which reads the split tiles at a sweep's edge), when the corridor touches any; and held to a
 * fairway gap strip where it lies inside one (`leg-depth.ts`, `bridgedSteps`). Which readings
 * apply follows from the corridor alone, never the draft, so the risk stays monotonic in it
 * (invariant 2). `strip` when the strip's reading stands.
 */
function* heldSteps(
  index: ChartIndex,
  [from, to]: [LonLat, LonLat],
  width: number,
  s: Scoring
): Steps<LegDepth & { strip: boolean }> {
  const d = yield* corridorSteps(index, from, to, width, s);
  let best: LegDepth & { strip: boolean } = { ...d, strip: false };
  let work = d.work;
  if (d.result.flags & SWEPT_BITS) {
    const swept = yield* corridorSteps(index, from, to, width, s, true);
    work += swept.work;
    if (swept.result.unswept === false && swept.result.maxRisk < best.result.maxRisk) {
      best = { ...swept, strip: false };
    }
  }
  const bridged = yield* bridgedSteps(index, from, to, width, s);
  if (bridged) {
    work += bridged.work;
    if (bridged.result.unswept === false && bridged.result.maxRisk < best.result.maxRisk) {
      best = { ...bridged, strip: true };
    }
  }
  return { ...best, work };
}

/** Scoring for a swept-water test alone: its risk is not read. */
const SWEPT_TEST: Scoring = { threshold: 0, sigmaExtra: 1 };

/**
 * Whether the corridor of the leg `ends` at `xte` plus a buffer lies in swept or dredged water
 * all through (`QueryOptions.sweptOnly`), or so through a fairway gap's strip (`leg-depth.ts`,
 * `bridgedSteps`): the test a leg's room is found by (`room.ts`); its work added to `work.n`.
 */
export function sweptAt(
  index: ChartIndex,
  [from, to]: [LonLat, LonLat],
  xte: number,
  work: { n: number } = { n: 0 }
): (buffer: number) => Steps<boolean> {
  return function* (buffer) {
    const d = yield* corridorSteps(index, from, to, xte + buffer, SWEPT_TEST, true);
    work.n += d.work;
    if (d.result.unswept === false) {
      return true;
    }
    // Through a fairway gap: the stretches inside a strip held to it, the rest swept.
    const bridged = yield* bridgedSteps(index, from, to, xte + buffer, SWEPT_TEST);
    work.n += bridged?.work ?? 0;
    return bridged?.result.unswept === false;
  };
}

function scoringFor(
  input: RouteCheckInput,
  speed: number,
  wl: WaterLevel
): { terms: VesselTerms; s: Scoring } {
  const terms = vesselTerms(input.vessel, { waveHeight: input.waveHeight }, input.dynamics);
  return { terms, s: { threshold: thresholdDepth(terms, wl), sigmaExtra: sigmaExtra(terms, wl) } };
}

/** A corridor's status; pushes WATER_LEVEL_FALLBACK to `flags` on a fallback level. */
function verdictStatus(
  risk: number,
  charted: number | null,
  bits: number,
  land: boolean,
  wl: WaterLevel,
  flags: string[],
  input: RouteCheckInput
): LegStatus {
  const status = land ? "fail" : statusOf(risk, charted, bits, input.probability);
  // A fallback water level is a guess, so a leg it clears is not verified (invariant 3).
  if (wl.degraded) {
    flags.push("WATER_LEVEL_FALLBACK");
    return status === "ok" ? "unverified" : status;
  }
  return status;
}

/** A footprint scored as a leg's corridor is (planning API, `src/planning-api.ts`). */
export interface FootprintVerdict {
  status: LegStatus;
  risk: number;
  flags: string[];
  worst?: LonLat;
  /** Work its query did (work.ts). */
  work: number;
  /** Some of the footprint is not swept or dredged water, or it was not asked (`sweptOnly`). */
  unswept: boolean;
}

/**
 * The ring `ring` scored as a leg's corridor at speed `speed`, at the water
 * level `input.waterLevel(start, end, at, true)`: every point in it is held to the
 * same threshold and status rules as a corridor of `checkLeg`.
 *
 * `at` holds the ring's vertices, and the level is taken over the ring as an area, so it
 * bounds the level of every point inside it: a level depends on position only through its
 * provider's reach, a disk (`LevelReach`, `model/water-level.ts`), and datums are taken at
 * their lowest over every cell. A vertex beyond the reach gives the ring the fallback; a
 * ring the reach can meet, even with every vertex beyond it, takes the level within the
 * reach as well; so the ring never gets more water than a leg inside it.
 */
export function checkFootprint(
  index: ChartIndex,
  input: RouteCheckInput,
  ring: LonLat[],
  speed: number,
  window: { start: number; end: number; at: readonly LonLat[] },
  sweptOnly = false
): FootprintVerdict {
  const wl = input.waterLevel(window.start, window.end, window.at, true);
  const { s } = scoringFor(input, speed, wl);
  const result = minDepthOver(index.pyramid, footprintGeom(ring), {
    chartPosition: true,
    clearAbove: s.threshold + CLEARANCE_RESOLUTION,
    risk: { threshold: s.threshold, sigmaExtra: s.sigmaExtra },
    sweptOnly
  });
  return footprintVerdict(index, input, ring, { result, work: queryWork(result), wl }, window);
}

/**
 * The ring `ring` scored as `checkFootprint` scores it, at the depth of the fairway gap strip
 * holding the whole of it (`gap-strips.ts`); undefined when no strip does.
 */
export function checkStripFootprint(
  index: ChartIndex,
  input: RouteCheckInput,
  ring: LonLat[],
  speed: number,
  window: { start: number; end: number; at: readonly LonLat[] }
): FootprintVerdict | undefined {
  const hold = stripHolding(index, ring);
  if (!hold) {
    return undefined;
  }
  const wl = input.waterLevel(window.start, window.end, window.at, true);
  const { s } = scoringFor(input, speed, wl);
  return footprintVerdict(index, input, ring, { ...heldDepth(index, ring, hold, s), wl }, window);
}

function footprintVerdict(
  index: ChartIndex,
  input: RouteCheckInput,
  ring: LonLat[],
  depth: { result: DepthResult; work: number; wl: WaterLevel },
  window: { start: number; end: number; at: readonly LonLat[] }
): FootprintVerdict {
  const { result, wl } = depth;
  const covered = result.coveredDMin;
  const land = covered === -Infinity;
  const charted = covered === Infinity || land ? null : covered;
  const flags = flagNames(result.flags);
  if (land) {
    flags.push("LAND");
  }
  const status = applyRules(
    verdictStatus(result.maxRisk, charted, result.flags, land, wl, flags, input),
    { index, input, flags },
    { ...window, rings: [ring], area: true }
  );
  return {
    status,
    risk: Math.round(result.maxRisk * 10000) / 10000,
    flags,
    worst: result.riskTile?.center,
    work: depth.work,
    unswept: result.unswept !== false
  };
}

export function checkRoute(
  index: ChartIndex,
  input: RouteCheckInput,
  now: number
): RouteCheckResult {
  return drain(routeSteps(index, input, now));
}

/** `checkRoute` that awaits `pause` after each corridor query. */
export async function checkRouteYielding(
  index: ChartIndex,
  input: RouteCheckInput,
  now: number,
  pause: () => Promise<void>
): Promise<RouteCheckResult> {
  const steps = routeSteps(index, input, now);
  for (;;) {
    const r = steps.next();
    if (r.done) {
      return r.value;
    }
    await pause();
  }
}

/** Legs of a route checked in order, and what checking them took. */
export interface CheckedLegs {
  legs: LegResult[];
  cells: Set<number>;
  /** Work their corridor queries did (work.ts). */
  work: number;
  /** False when the check stopped at `limit` before the last leg. */
  complete: boolean;
}

/**
 * Legs of `input` checked in order, the first leaving at `start`, each at
 * the time the one before ends; stops before a leg once `work` has reached
 * `limit`.
 */
export function* legsSteps(
  index: ChartIndex,
  input: RouteCheckInput,
  start: number,
  limit = Infinity
): Steps<CheckedLegs> {
  const legs: LegResult[] = [];
  const cells = new Set<number>();
  let work = 0;
  let t = start;
  for (let i = 0; i + 1 < input.coordinates.length; i++) {
    if (work >= limit) {
      return { legs, cells, work, complete: false };
    }
    const c = yield* legSteps(index, input, i, t);
    t = Date.parse(c.leg.eta.end);
    legs.push(c.leg);
    c.cellRefs.forEach((ref) => cells.add(ref));
    work += c.work;
  }
  return { legs, cells, work, complete: true };
}

function* routeSteps(
  index: ChartIndex,
  input: RouteCheckInput,
  now: number
): Steps<RouteCheckResult> {
  const { legs, cells } = yield* legsSteps(index, input, input.departure);
  const last = legs.at(-1);
  const t = last ? Date.parse(last.eta.end) : input.departure;
  const wl = input.waterLevel(input.departure, t, input.coordinates);
  return {
    checkedAt: new Date(now).toISOString(),
    charts: [...cells]
      .sort((a, b) => a - b)
      .flatMap((ref) => {
        const c = index.catalogue.cells[ref];
        return c ? [{ cell: c.name, edition: c.edition, update: c.update }] : [];
      }),
    waterLevelSource: wl.source,
    waterLevelDegraded: wl.degraded,
    legs
  };
}
