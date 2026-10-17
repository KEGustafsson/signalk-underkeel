import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine, project } from "../foundation/geo";
import { geomBounds } from "../foundation/geometry";
import type { VesselModel } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import type { DepthResult } from "../spatial/pyramid";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../spatial/pyramid";

/**
 * Corridor route check (plan §4.11), deterministic as in milestone M2: each
 * leg is checked over `buffer(leg, xteLimit + planning buffer)` against the
 * chart at chart datum with a fixed margin. A leg whose corridor touches
 * missing coverage or an unassessed survey is `unverified`, never `ok`
 * (safety invariant 4).
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
  /** Safety margin under the keel, metres. */
  margin: number;
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
  /** Charted depth minus draft and margin over the charted part; null when nothing is charted. */
  minUkc: number | null;
  /** Shallowest charted depth in the corridor, metres; null for land or nothing charted. */
  charted: number | null;
  flags: string[];
  worst?: {
    position: LonLat;
    hazard?: { class: string; lnam?: string; valsou: number | null };
  };
  explanation: { charted: number | null; draft: number; margin: number; waterLevel: number };
}

export interface RouteCheckResult {
  checkedAt: string;
  charts: { cell: string; edition: number; update: number }[];
  waterLevelSource: string;
  legs: LegResult[];
}

/** Long legs are checked in pieces this long so the corridor hugs the line. */
const SEGMENT_METRES = 1000;

const FLAG_NAMES: [number, string][] = [
  [FLAGS.SWEPT, "SWEPT"],
  [FLAGS.NO_COVERAGE, "NO_COVERAGE"],
  [FLAGS.UNASSESSED, "UNASSESSED"],
  [FLAGS.DREDGED, "DREDGED"],
  [FLAGS.LIVECHART_ADJUSTED, "LIVECHART_ADJUSTED"]
];

export function flagNames(flags: number): string[] {
  return FLAG_NAMES.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
}

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

/** Depths deeper than draft + margin + this are reported as a lower bound. */
const CLEARANCE_RESOLUTION = 5;

function checkCorridor(
  index: ChartIndex,
  a: LonLat,
  b: LonLat,
  r: number,
  clearAbove: number
): LegDepth {
  let best: LegDepth | undefined;
  let flags = 0;
  const cells = new Set<number>();
  for (const [p, q] of pieces(a, b, haversine(a, b))) {
    const ring = corridorRing(p, q, r);
    const result = minDepthOver(index.pyramid, footprintGeom(ring), { clearAbove });
    flags |= result.flags;
    result.cellRefs.forEach((c) => cells.add(c));
    if (best === undefined || result.coveredDMin < best.result.coveredDMin) {
      best = { result, ring };
    }
  }
  const leg = best as LegDepth;
  return { ...leg, result: { ...leg.result, flags, cellRefs: [...cells] } };
}

function statusOf(minUkc: number | null, margin: number, flags: number): LegStatus {
  if (minUkc !== null && minUkc + margin < 0) {
    return "fail";
  }
  if (minUkc === null || flags & (FLAGS.NO_COVERAGE | FLAGS.UNASSESSED)) {
    return "unverified";
  }
  return minUkc < 0 ? "marginal" : "ok";
}

function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

type Hazard = { class: string; lnam?: string; valsou: number | null };

/**
 * The charted hazard behind the corridor's shallowest depth, if it is a
 * named one. A shallower hazard did not set that depth (it would have
 * lowered it), so only one at exactly that depth is named.
 */
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

function checkLeg(
  index: ChartIndex,
  input: RouteCheckInput,
  i: number,
  start: number
): { leg: LegResult; cellRefs: number[] } {
  const from = input.coordinates[i] as LonLat;
  const to = input.coordinates[i + 1] as LonLat;
  const length = haversine(from, to);
  const end = start + (length / (input.speeds[i] as number)) * 1000;
  const { result, ring } = checkCorridor(
    index,
    from,
    to,
    input.xteLimit + input.planningBuffer,
    input.vessel.draft + input.margin + CLEARANCE_RESOLUTION
  );
  const covered = result.coveredDMin;
  const nothingCharted = covered === Infinity;
  const land = covered === -Infinity;
  const charted = nothingCharted || land ? null : covered;
  const minUkc = charted === null ? null : charted - input.vessel.draft - input.margin;
  const flags = flagNames(result.flags);
  if (land) {
    flags.push("LAND");
  }
  const leg: LegResult = {
    index: i,
    status: land ? "fail" : statusOf(minUkc, input.margin, result.flags),
    from,
    to,
    length: Math.round(length),
    eta: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    minUkc: minUkc === null ? null : finiteOrNull(minUkc),
    charted: charted === null ? null : finiteOrNull(charted),
    flags,
    worst: result.worst && {
      position: result.worst.center,
      hazard: nothingCharted ? undefined : hazardIn(index, ring, covered)
    },
    explanation: {
      charted: charted === null ? null : finiteOrNull(charted),
      draft: input.vessel.draft,
      margin: input.margin,
      waterLevel: 0
    }
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
    waterLevelSource: "chart-datum",
    legs
  };
}
