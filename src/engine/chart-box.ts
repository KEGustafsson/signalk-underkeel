import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, wrapLon } from "../foundation/geo";
import type { Bbox } from "../ingest/wfs";
import { MAX_CHART_BUFFER } from "../spatial/chart-position";
import type { FootprintResult } from "./lookahead";
import type { RouteCheckResult } from "./route-check";
import { NO_COVERAGE } from "./verdict";

/**
 * Says when no chart coverage is the edge of the chart box around the vessel (plan §4.2), not
 * a gap in the charts: the index is built only in that box, so past it every tile reads no
 * coverage until the box is rebuilt around the vessel. Only reasons change; the state and the
 * flags stay as the charts left them (invariants 3 and 4).
 */

/** The box service as the look-ahead and the route check see it. */
export interface ChartBoxView {
  /** The box the index in use was built in; absent before the first. */
  bbox?: Bbox;
  rebuilding: boolean;
  /** The last rebuild failed and none runs now. */
  failed: boolean;
  /** How long the last build took, ms. */
  lastMs?: number;
  /** The box service's status line, when it has something to say. */
  summary?: string;
}

/** A duration as the status says it: tens of seconds under 90 s, else whole minutes. */
export function spoken(ms: number): string {
  const s = Math.max(0, ms / 1000);
  return s < 90 ? `${Math.round(s / 10) * 10} s` : `${Math.round(s / 60)} min`;
}

const M_PER_DEG = (EARTH_RADIUS * Math.PI) / 180;

/** Whether `p` lies inside `bbox` at least `margin` metres from each edge. */
export function insideBox(p: LonLat, [w, s, e, n]: Bbox, margin = 0): boolean {
  const k = M_PER_DEG * Math.cos((p[1] * Math.PI) / 180);
  return (
    (p[1] - s) * M_PER_DEG >= margin &&
    (n - p[1]) * M_PER_DEG >= margin &&
    wrapLon(p[0] - w) * k >= margin &&
    wrapLon(e - p[0]) * k >= margin
  );
}

const COVERAGE_REASON = new RegExp(`^${NO_COVERAGE} (?:at the vessel|ahead in (\\d+) s)$`);

/**
 * Whether footprint `f` reaches the box edge: a tile across the edge reads no coverage and
 * flags footprints up to their buffer plus the widest chart position reach inside it.
 */
function atEdge(f: FootprintResult, bbox: Bbox): boolean {
  const ring = f.ring.length > 0 ? f.ring : [f.center];
  return ring.some((p) => !insideBox(p, bbox, MAX_CHART_BUFFER + f.buffer));
}

function boxState(box: ChartBoxView): string {
  if (box.rebuilding) {
    const last = box.lastMs === undefined ? "" : ` (last build took ${spoken(box.lastMs)})`;
    return `the box is rebuilding around the vessel${last}`;
  }
  return box.failed ? "the box rebuild failed and is retried" : "a box rebuild is due";
}

/**
 * `reason` with what the chart box has to do with it, when it is a no-coverage reason
 * (`verdict.ts`) and the footprint it names reaches the box edge; otherwise `reason`. The
 * footprint is the first at or after the time the reason gives.
 */
export function boxCoverage(
  reason: string,
  fps: readonly FootprintResult[],
  box: ChartBoxView
): string {
  const m = COVERAGE_REASON.exec(reason);
  if (!m || !box.bbox) {
    return reason;
  }
  const t = m[1] === undefined ? 0 : Number(m[1]);
  const f = fps.find((x) => x.t >= t - 0.5) ?? fps[fps.length - 1];
  if (!f || !atEdge(f, box.bbox)) {
    return reason;
  }
  const where = insideBox(f.center, box.bbox) ? "at the chart box edge" : "outside the chart box";
  return `${reason}: ${where}, ${boxState(box)}`;
}

/** `r` with its reason through `boxCoverage`; the state and everything else stay. */
export function withBoxReason<T extends { reason: string; footprints: FootprintResult[] }>(
  r: T,
  box: ChartBoxView | undefined
): T {
  const reason = box ? boxCoverage(r.reason, r.footprints, box) : r.reason;
  return reason === r.reason ? r : { ...r, reason };
}

/** Why a leg is unverified when its corridor reaches past the box. */
export const OUTSIDE_BOX_REASON =
  "the leg reaches outside the chart box around the vessel, where no chart is indexed; it is checked once the box follows the vessel there";

/**
 * Route check legs left unverified by no coverage, whose corridor of `halfWidth` metres comes
 * within chart position reach of the box edge, get OUTSIDE_BOX_REASON. Both ends inside the
 * box keep the straight leg between them inside it too.
 */
export function explainOutsideBox(
  r: RouteCheckResult,
  bbox: Bbox | undefined,
  halfWidth: number
): RouteCheckResult {
  if (!bbox) {
    return r;
  }
  const margin = halfWidth + MAX_CHART_BUFFER;
  const legs = r.legs.map((leg) =>
    leg.status === "unverified" &&
    leg.flags.includes("NO_COVERAGE") &&
    !(insideBox(leg.from, bbox, margin) && insideBox(leg.to, bbox, margin))
      ? { ...leg, reason: OUTSIDE_BOX_REASON }
      : leg
  );
  return { ...r, legs };
}
