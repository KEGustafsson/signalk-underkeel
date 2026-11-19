import type { Bbox } from "./ingest/wfs";
import type { PlanningBoxes } from "./planning-box";
import { holds, regionError } from "./planning-box";
import type { Survey } from "./survey";
import { SURVEY_MIN_CELL_M } from "./survey";

/**
 * The depth survey and the corridor in planning API v1 (`planning-api.ts`, features "survey"
 * and "corridor"): the planner surveys a region too large for one planning box, finds a
 * corridor on the survey, and prepares the corridor's boxes alone.
 */

export type SurveyResult =
  { ok: true; value: Survey } | { ok: false; status: number; error: string };

/** A corridor is cut into at most this many boxes. */
export const MAX_CORRIDOR_PARTS = 400;

/** Why `corridor` is not a corridor within `region`, or undefined when it is. */
export function corridorError(region: Bbox, corridor: readonly unknown[]): string | undefined {
  if (corridor.length === 0 || corridor.length > MAX_CORRIDOR_PARTS) {
    return `corridor must be 1 to ${MAX_CORRIDOR_PARTS} boxes`;
  }
  for (const p of corridor) {
    const bad = regionError(p);
    if (bad !== undefined) {
      return `corridor box: ${bad}`;
    }
    if (!holds(region, p as Bbox)) {
      return "every corridor box must lie in the region";
    }
  }
  return undefined;
}

/** The planning API's `survey`, over the planning boxes `boxes` serves. */
export function surveyOver(boxes: () => PlanningBoxes | undefined) {
  return async (region: Bbox, cellMetres: number, signal: AbortSignal): Promise<SurveyResult> => {
    const bad = regionError(region);
    if (bad !== undefined) {
      return { ok: false, status: 400, error: bad };
    }
    if (!Number.isFinite(cellMetres) || cellMetres < SURVEY_MIN_CELL_M) {
      return { ok: false, status: 400, error: `cellMetres must be at least ${SURVEY_MIN_CELL_M}` };
    }
    const b = boxes();
    if (!b) {
      return { ok: false, status: 503, error: "no planning box can be built, nor a survey made" };
    }
    const r: Bbox = [region[0], region[1], region[2], region[3]];
    const got = await b.survey(r, cellMetres, signal);
    return got.ok ? { ok: true, value: got.survey } : got;
  };
}
