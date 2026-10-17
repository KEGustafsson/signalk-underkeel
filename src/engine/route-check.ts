import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine, project } from "../foundation/geo";
import { geomBounds } from "../foundation/geometry";
import type { VesselTerms, WaterLevel } from "../model/uncertainty";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import type { DynamicsOptions, VesselModel } from "../model/vessel";
import { vesselTerms } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS, flagNames } from "../spatial/node-store";
import type { DepthResult, RiskTile } from "../spatial/pyramid";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../spatial/pyramid";
import type { Explanation } from "./explain";
import { explain } from "./explain";

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
  /** Water level over the leg's arrival interval [start, end] (epoch ms); the worst one is used. */
  waterLevel(start: number, end: number): WaterLevel;
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
  legs: LegResult[];
}

/** Long legs are checked in pieces this long so the corridor hugs the line. */
const SEGMENT_METRES = 1000;

/** True bearing from a to b in the local tangent plane, radians. */
function bearing(a: LonLat, b: LonLat): number {
  const deg = Math.PI / 180;
  const east = (b[0] - a[0]) * deg * EARTH_RADIUS * Math.cos(a[1] * deg);
  const north = (b[1] - a[1]) * deg * EARTH_RADIUS;
  return Math.atan2(east, north);
}

/**
 * Rectangle around segment a→b, `r` metres to each side and past each
 * end. It contains the capsule buffer(a→b, r), so the check is never
 * narrower than the corridor.
 */
export function corridorRing(a: LonLat, b: LonLat, r: number): LonLat[] {
  const brg = bearing(a, b);
  const start = project(a, brg + Math.PI, r);
  const end = project(b, brg, r);
  return [
    project(end, brg + Math.PI / 2, r),
    project(start, brg + Math.PI / 2, r),
    project(start, brg - Math.PI / 2, r),
    project(end, brg - Math.PI / 2, r)
  ];
}

function pieces(a: LonLat, b: LonLat, length: number): [LonLat, LonLat][] {
  const n = Math.max(1, Math.ceil(length / SEGMENT_METRES));
  const brg = bearing(a, b);
  const points: LonLat[] = [a];
  for (let i = 1; i < n; i++) {
    points.push(project(a, brg, (length * i) / n));
  }
  points.push(b);
  return points.slice(1).map((p, i) => [points[i] as LonLat, p]);
}

interface LegDepth {
  result: DepthResult;
  ring: LonLat[];
}

/** Depths deeper than the UKC-zero depth plus this are reported as a lower bound. */
const CLEARANCE_RESOLUTION = 5;

interface Scoring {
  threshold: number;
  sigmaExtra: number;
}

function checkCorridor(index: ChartIndex, a: LonLat, b: LonLat, r: number, s: Scoring): LegDepth {
  let best: LegDepth | undefined;
  let flags = 0;
  let covered = Infinity;
  const cells = new Set<number>();
  for (const [p, q] of pieces(a, b, haversine(a, b))) {
    const ring = corridorRing(p, q, r);
    const result = minDepthOver(index.pyramid, footprintGeom(ring), {
      clearAbove: s.threshold + CLEARANCE_RESOLUTION,
      risk: { threshold: s.threshold, sigmaExtra: s.sigmaExtra }
    });
    flags |= result.flags;
    covered = Math.min(covered, result.coveredDMin);
    result.cellRefs.forEach((c) => cells.add(c));
    if (best === undefined || result.maxRisk > best.result.maxRisk) {
      best = { result, ring };
    }
  }
  const leg = best as LegDepth;
  return { ...leg, result: { ...leg.result, flags, coveredDMin: covered, cellRefs: [...cells] } };
}

function statusOf(risk: number, charted: number | null, flags: number, p: number): LegStatus {
  if (risk >= 5 * p) {
    return "fail";
  }
  if (charted === null || flags & (FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH)) {
    return "unverified";
  }
  return risk >= p ? "marginal" : "ok";
}

function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

type Hazard = { class: string; lnam?: string; valsou: number | null };

/** The named hazard whose depth is the deciding tile's depth: the one that set it. */
function hazardIn(index: ChartIndex, ring: LonLat[], depth: number): Hazard | undefined {
  const geom = footprintGeom(ring);
  const hit = index.hazards
    .near(geom, mercatorBuffer(geomBounds(geom), 0))
    .find((h) => h.feature.depth === depth);
  return (
    hit && {
      class: hit.feature.objectClass,
      lnam: hit.feature.lnam,
      valsou: finiteOrNull(hit.feature.depth)
    }
  );
}

function legExplanation(
  index: ChartIndex,
  tile: RiskTile,
  ring: LonLat[],
  terms: VesselTerms,
  wl: WaterLevel
): { hazard?: Hazard; explanation: Explanation } {
  const hazard = hazardIn(index, ring, tile.dMin);
  const cell = index.catalogue.cells[tile.cellRef];
  const explanation = explain(
    tile,
    {
      flags: flagNames(tile.flags),
      cell: cell && { name: cell.name, edition: cell.edition, update: cell.update },
      hazard: hazard && {
        class: hazard.class,
        lnam: hazard.lnam,
        depth: hazard.valsou ?? -Infinity
      }
    },
    terms,
    wl
  );
  return { hazard, explanation };
}

function checkLeg(
  index: ChartIndex,
  input: RouteCheckInput,
  i: number,
  start: number
): { leg: LegResult; cellRefs: number[] } {
  const from = input.coordinates[i] as LonLat;
  const to = input.coordinates[i + 1] as LonLat;
  const length = haversine(from, to);
  const speed = input.speeds[i] as number;
  const end = start + (length / speed) * 1000;
  const wl = input.waterLevel(start, end);
  const terms = vesselTerms(input.vessel, { speed, waveHeight: input.waveHeight }, input.dynamics);
  const s = { threshold: thresholdDepth(terms, wl), sigmaExtra: sigmaExtra(terms, wl) };
  const { result, ring } = checkCorridor(index, from, to, input.xteLimit + input.planningBuffer, s);
  const covered = result.coveredDMin;
  const land = covered === -Infinity;
  const charted = covered === Infinity || land ? null : covered;
  const flags = flagNames(result.flags);
  if (land) {
    flags.push("LAND");
  }
  const tile = result.riskTile;
  const why = tile ? legExplanation(index, tile, ring, terms, wl) : undefined;
  const leg: LegResult = {
    index: i,
    status: land ? "fail" : statusOf(result.maxRisk, charted, result.flags, input.probability),
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
  return { leg, cellRefs: result.cellRefs };
}

export function checkRoute(
  index: ChartIndex,
  input: RouteCheckInput,
  now: number
): RouteCheckResult {
  const legs: LegResult[] = [];
  const cells = new Set<number>();
  let t = input.departure;
  for (let i = 0; i + 1 < input.coordinates.length; i++) {
    const { leg, cellRefs } = checkLeg(index, input, i, t);
    t = Date.parse(leg.eta.end);
    legs.push(leg);
    cellRefs.forEach((c) => cells.add(c));
  }
  return {
    checkedAt: new Date(now).toISOString(),
    charts: [...cells]
      .sort((a, b) => a - b)
      .flatMap((ref) => {
        const c = index.catalogue.cells[ref];
        return c ? [{ cell: c.name, edition: c.edition, update: c.update }] : [];
      }),
    waterLevelSource: input.waterLevel(input.departure, t).source,
    legs
  };
}
