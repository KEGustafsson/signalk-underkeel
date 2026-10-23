import type { LonLat } from "../foundation/geo";
import { fromMercator, haversine, offset, project, toMercator, wrapLon } from "../foundation/geo";
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
  /** Planning position uncertainty added to the corridor, metres. */
  planningBuffer: number;
  vessel: VesselModel;
  dynamics: DynamicsOptions;
  /**
   * Water level over the arrival interval [start, end] (epoch ms) at the
   * positions `at`, a leg's two ends; the worst one is used.
   */
  waterLevel(start: number, end: number, at: readonly LonLat[]): WaterLevel;
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
}

export interface RouteCheckResult {
  checkedAt: string;
  charts: { cell: string; edition: number; update: number }[];
  waterLevelSource: string;
  /** Set when the water level over the route is a fallback, with the reason. */
  waterLevelDegraded?: string;
  legs: LegResult[];
}

/**
 * Long legs are checked in pieces at least this long, and at least four
 * corridor half-widths: each piece reaches r past both ends, so shorter
 * pieces of a wide corridor would query the same water several times.
 */
const SEGMENT_METRES = 1000;

/** b moved by whole turns of longitude to within 180° of a: the short way round. */
function nearSide(a: LonLat, b: LonLat): LonLat {
  return [a[0] + wrapLon(b[0] - a[0]), b[1]];
}

/** True bearing from a to b in the tangent plane at a that `project` offsets in, radians. */
function bearing(a: LonLat, b: LonLat): number {
  const east = (nearSide(a, b)[0] - a[0]) / (offset(a, 1, 0)[0] - a[0]);
  const north = (b[1] - a[1]) / (offset(a, 0, 1)[1] - a[1]);
  return Math.atan2(east, north);
}

/**
 * Relative widening of every ring. Over a piece the Mercator chart and the
 * tangent plane at its start drift apart: a ring exactly r wide missed
 * points r off the rhumb line by up to 0.15 % of r (measured up to 84°,
 * pieces up to 4r long).
 */
const RING_SLACK = 1 / 256;

/**
 * Rectangle around segment a→b, `r` metres to each side and past each
 * end. It contains the capsule buffer(a→b, r) around the segment drawn
 * straight on the chart, so the check is never narrower than the corridor.
 * Across ±180° the ring keeps a's side and reaches past it.
 */
export function corridorRing(a: LonLat, b: LonLat, rMetres: number): LonLat[] {
  const brg = bearing(a, b);
  const r = rMetres * (1 + RING_SLACK);
  const start = project(a, brg + Math.PI, r);
  const end = project(nearSide(a, b), brg, r);
  return [
    project(end, brg + Math.PI / 2, r),
    project(start, brg + Math.PI / 2, r),
    project(start, brg - Math.PI / 2, r),
    project(end, brg - Math.PI / 2, r)
  ];
}

/** The point `t` of the way along the rhumb line a→b, the line drawn straight on the chart. */
function alongRhumb(a: LonLat, b: LonLat, t: number): LonLat {
  const near = nearSide(a, b);
  const [ax, ay] = toMercator(a[0], a[1]);
  const [bx, by] = toMercator(near[0], near[1]);
  const p = fromMercator(ax + (bx - ax) * t, ay + (by - ay) * t);
  return [wrapLon(p[0]), p[1]];
}

function unitVector(p: LonLat): [number, number, number] {
  const k = Math.PI / 180;
  const c = Math.cos(p[1] * k);
  return [c * Math.cos(p[0] * k), c * Math.sin(p[0] * k), Math.sin(p[1] * k)];
}

/** The point `t` of the way along the great circle a→b, the line a navigator steering it follows. */
function alongGreatCircle(a: LonLat, b: LonLat, t: number): LonLat {
  const va = unitVector(a);
  const vb = unitVector(b);
  const omega = Math.acos(Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  if (omega === 0) {
    return a;
  }
  const wa = Math.sin((1 - t) * omega) / Math.sin(omega);
  const wb = Math.sin(t * omega) / Math.sin(omega);
  const [x, y, z] = va.map((c, i) => wa * c + wb * (vb[i] as number)) as [number, number, number];
  const deg = 180 / Math.PI;
  return [Math.atan2(y, x) * deg, Math.atan2(z, Math.hypot(x, y)) * deg];
}

/** Upper bound of the gap between a leg's rhumb line and its great circle, metres. */
function greatCircleOffset(a: LonLat, b: LonLat): number {
  let gap = 0;
  for (let i = 1; i < 8; i++) {
    gap = Math.max(gap, haversine(alongRhumb(a, b, i / 8), alongGreatCircle(a, b, i / 8)));
  }
  return gap;
}

/**
 * Below this gap, or a quarter of the corridor half-width, the rhumb
 * corridor is widened by the gap; above, the great circle gets its own.
 */
const GREAT_CIRCLE_TOLERANCE = 10;

type Line = (a: LonLat, b: LonLat, t: number) => LonLat;

/**
 * How far a line strays from the chords between its points, metres: the
 * gap at a quarter, half and three quarters of each piece to the point as
 * far along the chord. The rhumb line is its own chord on the chart.
 */
function chordGap(along: Line, a: LonLat, b: LonLat, points: LonLat[]): number {
  if (along === alongRhumb) {
    return 0;
  }
  const n = points.length - 1;
  let gap = 0;
  for (let i = 0; i < n; i++) {
    for (const s of [0.25, 0.5, 0.75]) {
      const chord = alongRhumb(points[i] as LonLat, points[i + 1] as LonLat, s);
      gap = Math.max(gap, haversine(along(a, b, (i + s) / n), chord));
    }
  }
  return gap;
}

/**
 * Corridor rings that together contain every point within `r` of both the
 * rhumb line a→b, as a chart plotter draws the leg, and its great circle,
 * as a course computer may steer it. Each line is split into pieces of
 * about max(SEGMENT_METRES, 4r) at equal fractions, so the last piece ends
 * on b, and each ring is widened by how far its line strays from the chord.
 */
export function legCorridors(a: LonLat, b: LonLat, r: number): LonLat[][] {
  const n = Math.max(1, Math.ceil(haversine(a, b) / Math.max(SEGMENT_METRES, 4 * r)));
  const gap = greatCircleOffset(a, b);
  const apart = gap > Math.max(GREAT_CIRCLE_TOLERANCE, r / 4);
  const lines = apart ? [alongRhumb, alongGreatCircle] : [alongRhumb];
  return lines.flatMap((along) => {
    const points = Array.from({ length: n + 1 }, (_, i) =>
      i === 0 ? a : i === n ? b : along(a, b, i / n)
    );
    const width = (apart ? r : r + gap) + chordGap(along, a, b, points);
    return points.slice(1).map((q, i) => corridorRing(points[i] as LonLat, q, width));
  });
}

interface LegDepth {
  result: DepthResult;
  ring: LonLat[];
  /** Work its corridor queries did (work.ts). */
  work: number;
}

/** Depths deeper than the UKC-zero depth plus this are reported as a lower bound. */
const CLEARANCE_RESOLUTION = 5;

interface Scoring {
  threshold: number;
  sigmaExtra: number;
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

function* corridorSteps(
  index: ChartIndex,
  a: LonLat,
  b: LonLat,
  r: number,
  s: Scoring
): Steps<LegDepth> {
  let best: Omit<LegDepth, "work"> | undefined;
  let flags = 0;
  let covered = Infinity;
  let work = 0;
  const cells = new Set<number>();
  for (const ring of legCorridors(a, b, r)) {
    const result = minDepthOver(index.pyramid, footprintGeom(ring), {
      chartPosition: true,
      clearAbove: s.threshold + CLEARANCE_RESOLUTION,
      risk: { threshold: s.threshold, sigmaExtra: s.sigmaExtra }
    });
    work += queryWork(result);
    flags |= result.flags;
    covered = Math.min(covered, result.coveredDMin);
    result.cellRefs.forEach((c) => cells.add(c));
    if (best === undefined || result.maxRisk > best.result.maxRisk) {
      best = { result, ring };
    }
    yield;
  }
  const leg = best as Omit<LegDepth, "work">;
  return {
    ...leg,
    work,
    result: { ...leg.result, flags, coveredDMin: covered, cellRefs: [...cells] }
  };
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
  const terms = vesselTerms(input.vessel, { speed, waveHeight: input.waveHeight }, input.dynamics);
  const s = { threshold: thresholdDepth(terms, wl), sigmaExtra: sigmaExtra(terms, wl) };
  const { result, ring, work } = yield* corridorSteps(
    index,
    from,
    to,
    input.xteLimit + input.planningBuffer,
    s
  );
  const covered = result.coveredDMin;
  const land = covered === -Infinity;
  const charted = covered === Infinity || land ? null : covered;
  const flags = flagNames(result.flags);
  if (land) {
    flags.push("LAND");
  }
  const tile = result.riskTile;
  const why = tile ? explainTile(index, tile, ring, terms, wl) : undefined;
  let status: LegStatus = land
    ? "fail"
    : statusOf(result.maxRisk, charted, result.flags, input.probability);
  // A fallback water level is a guess, so a leg it clears is not verified (invariant 3).
  if (wl.degraded) {
    flags.push("WATER_LEVEL_FALLBACK");
    if (status === "ok") {
      status = "unverified";
    }
  }
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
