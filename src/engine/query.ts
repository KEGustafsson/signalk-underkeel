import type { LonLat } from "../foundation/geo";
import type { VesselTerms, WaterLevel } from "../model/uncertainty";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS, flagNames } from "../spatial/node-store";
import type { DepthResult } from "../spatial/pyramid";
import { footprintGeom, minDepthOver } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { FootprintClass } from "./envelope";
import { classOf } from "./envelope";
import type { Explanation, NamedHazard } from "./explain";
import { explainTile, sentence } from "./explain";
import type { Thresholds } from "./lookahead";

/**
 * `POST /query` (plan §4.10): UKC at a point or over a polygon for the
 * current vessel and water level, for cursor readouts and popovers.
 */

export interface QueryInput {
  /** One position, or a polygon ring without the repeated first point. */
  ring: LonLat[];
  bufferMetres: number;
  terms: VesselTerms;
  waterLevel: WaterLevel;
  thresholds: Thresholds;
}

export interface QueryResult {
  class: FootprintClass;
  /** Shallowest charted depth, metres; null with no depth data. */
  charted: number | null;
  /** Mean UKC at the deciding tile, metres; null with no depth data. */
  mean: number | null;
  sigma: number;
  risk: number;
  flags: string[];
  cells: { cell: string; edition: number; update: number }[];
  hazard?: NamedHazard;
  explanation?: Explanation;
  sentence?: string;
  waterLevelDegraded?: string;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * An unassessed survey is no more a verified depth here than on a route
 * leg, and nothing is clear against a fallback water level.
 */
function classFor(
  r: DepthResult,
  charted: number | null,
  wl: WaterLevel,
  th: Thresholds
): FootprintClass {
  const uncovered =
    (r.flags & (FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NOT_FOR_NAVIGATION)) !== 0 ||
    charted === null;
  const cls = classOf({ risk: r.maxRisk, uncovered, charted }, th);
  return wl.degraded && cls === "clear" ? "unverified" : cls;
}

export function queryUkc(index: ChartIndex, input: QueryInput): QueryResult {
  const wl = input.waterLevel;
  const risk = {
    threshold: thresholdDepth(input.terms, wl),
    sigmaExtra: sigmaExtra(input.terms, wl)
  };
  const r = minDepthOver(index.pyramid, footprintGeom(input.ring), {
    bufferMetres: input.bufferMetres,
    chartPosition: true,
    risk
  });
  const covered = r.coveredDMin;
  const charted = covered === Infinity ? null : covered;
  const flags = flagNames(r.flags);
  if (charted === -Infinity) {
    flags.push("LAND");
  }
  const tile = r.riskTile;
  const why = tile
    ? explainTile(index, tile, input.ring, input.terms, wl, input.bufferMetres)
    : undefined;
  return {
    class: classFor(r, charted, wl, input.thresholds),
    charted: charted === null ? null : Number.isFinite(charted) ? r2(charted) : null,
    mean: why?.explanation.mean ?? null,
    sigma: why?.explanation.sigma ?? r2(risk.sigmaExtra),
    risk: Math.round(r.maxRisk * 10000) / 10000,
    flags,
    cells: r.cellRefs.flatMap((ref) => {
      const c = index.catalogue.cells[ref];
      return c ? [{ cell: c.name, edition: c.edition, update: c.update }] : [];
    }),
    hazard: why?.hazard,
    explanation: why?.explanation,
    sentence: why && sentence(why.explanation),
    waterLevelDegraded: wl.degraded
  };
}
