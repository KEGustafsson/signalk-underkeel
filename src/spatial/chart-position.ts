import type { Geom } from "../foundation/geometry";
import type { NodeStore } from "./node-store";
import type { DepthResult, QueryOptions } from "./pyramid";
import { minDepthOver } from "./pyramid";
import { DEFAULT_BUILD } from "./pyramid-build";

/**
 * Depth areas and lines are not widened by their survey's position
 * uncertainty when the pyramid is built (only point hazards are burned),
 * so a query carries it in its buffer (plan §4.3, §4.7): k·σP of the
 * assessed surveys the footprint reaches, k as the build burns point
 * hazards with. Unassessed and not-for-navigation water adds no buffer:
 * its flags already keep a footprint from reading as safe (invariant 4),
 * and a 1 km guess would fail nearly every leg near land.
 * A wider buffer can reach a worse survey, so the query is repeated until
 * σP stops growing.
 */

/** Chart position buffer at most, metres: k·σP of an unassessed survey. */
export const MAX_CHART_BUFFER = 1000;

export interface ChartPositionResult {
  result: DepthResult;
  /** The ground buffer the result was queried with, metres. */
  bufferMetres: number;
}

/**
 * `minDepthOver` with the ground buffer widened by k·σP. Each repeat
 * widens the buffer to a σP the last query found and σP takes finitely
 * many values, so the loop ends.
 */
export function minDepthWithChartPosition(
  store: NodeStore,
  geom: Geom,
  opts: QueryOptions = {}
): ChartPositionResult {
  const base = opts.bufferMetres ?? 0;
  let bufferMetres = base;
  let result = minDepthOver(store, geom, opts);
  for (;;) {
    const need = base + Math.min(MAX_CHART_BUFFER, DEFAULT_BUILD.k * result.surveySigmaP);
    if (need <= bufferMetres) {
      return { result, bufferMetres };
    }
    bufferMetres = need;
    result = minDepthOver(store, geom, { ...opts, bufferMetres });
  }
}
