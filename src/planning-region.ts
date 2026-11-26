import { EARTH_RADIUS } from "./foundation/geo";
import { cellSources } from "./index-loader";
import type { Bbox } from "./ingest/wfs";
import { bboxProblem } from "./ingest/wfs";
import { isAdvisorySource } from "./ingest/advisory";
import type { BoxJobDeps } from "./wfs-worker";
import { growBbox } from "./spatial/build-box";
import { MAX_CHART_BUFFER } from "./spatial/chart-position";

/** The regions planning boxes are asked for and built in (`planning-box.ts`). */

/** `[w, s, e, n]` with each side finite, west of east, south of north, within ±85°. */
export function regionError(r: unknown): string | undefined {
  const ok =
    Array.isArray(r) &&
    r.length === 4 &&
    r.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    (r[0] as number) >= -180 &&
    (r[2] as number) <= 180 &&
    (r[1] as number) >= -85 &&
    (r[3] as number) <= 85 &&
    (r[0] as number) < (r[2] as number) &&
    (r[1] as number) < (r[3] as number);
  return ok
    ? undefined
    : "region must be [west, south, east, north] in degrees, west < east, south < north, within ±85°";
}

/** The area of `b`, km², on a sphere. */
export function bboxKm2([w, s, e, n]: Bbox): number {
  const k = Math.PI / 180;
  const r = EARTH_RADIUS / 1000;
  return r * r * (e - w) * k * (Math.sin(n * k) - Math.sin(s * k));
}

/** Whether `outer` holds all of `inner`. */
export function holds(outer: Bbox, inner: Bbox): boolean {
  return (
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
  );
}

/** The box a planning index of `region` is built in: grown by the widest chart position reach. */
export function planningBbox(region: Bbox): Bbox {
  return growBbox(region, MAX_CHART_BUFFER / 1000);
}

/** What of a build's settings its size is measured by. */
type Measured = Pick<BoxJobDeps, "config" | "index" | "cellsDir">;

/**
 * How a planning box of `bbox`, or of its corridor's `parts`, is measured against the cap:
 * its WFS depths are downloaded for the parts alone, and with WFS depths alone in use its area
 * is theirs; S-57 cells are built across the whole box, which is then the area.
 */
export function boxMeasure(
  deps: Measured,
  bbox: Bbox,
  parts?: readonly Bbox[]
): { km2: number; wfs: boolean; corridor: boolean } {
  const wfs = "url" in deps.config;
  // The cells the build reads: those of the index in use, and any S-57 cell in cellsDir now.
  const cells =
    deps.index()?.catalogue.cells.some((c) => !isAdvisorySource(c.source)) === true ||
    (parts !== undefined && cellSources(deps.cellsDir).length > 0);
  const corridor = parts !== undefined && wfs && !cells;
  const km2 = corridor ? parts.reduce((sum, p) => sum + bboxKm2(p), 0) : bboxKm2(bbox);
  return { km2, wfs, corridor };
}

/**
 * The area a planning build of `bbox` (or `parts`) that ran out of memory is measured at, which
 * halved is the cap from then on; the corridor's alone when the cells cannot be read now.
 */
export function failedKm2(deps: () => Measured, bbox: Bbox, parts?: readonly Bbox[]): number {
  try {
    return boxMeasure(deps(), bbox, parts).km2;
  } catch {
    return parts ? parts.reduce((sum, p) => sum + bboxKm2(p), 0) : bboxKm2(bbox);
  }
}

/**
 * Why a planning box of `bbox`, or of its corridor's `parts`, is not built on a machine that
 * builds at most `maxKm2`, or undefined.
 */
export function tooLarge(
  deps: Measured,
  maxKm2: number,
  bbox: Bbox,
  parts?: readonly Bbox[]
): string | undefined {
  const { km2, wfs, corridor } = boxMeasure(deps, bbox, parts);
  if (km2 > maxKm2) {
    return `the planning box would be ${Math.round(km2)} km²${corridor ? " in its corridor" : " with its reach"}; at most ${Math.round(maxKm2)} km² on this machine`;
  }
  // A Traficom WFS download has its own span limits, which no retry passes; a corridor's is
  // of its boxes, S-57 cells in use or not.
  const problem = wfs ? (parts ?? [bbox]).map(bboxProblem).find((p) => p) : undefined;
  return problem === undefined
    ? undefined
    : `the planning box is too large for the Traficom WFS: ${problem}`;
}

/** Whether `held` judges on the charts every query in `region`, or in each of its `parts`. */
export function covers(
  held: { region: Bbox; parts?: readonly Bbox[] | undefined },
  region: Bbox,
  parts?: readonly Bbox[]
): boolean {
  const have = held.parts ?? [held.region];
  return (parts ?? [region]).every((p) => have.some((q) => holds(q, p)));
}
