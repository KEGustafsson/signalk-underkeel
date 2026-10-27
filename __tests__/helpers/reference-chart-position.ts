import { expandRect, tileRange, tileRect } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import { geomBounds, geomRectDistance } from "../../src/foundation/geometry";
import { normalCdf, probabilityBelowZero } from "../../src/foundation/stats";
import {
  chartReach,
  chartSigma,
  chartWeight,
  FLAG_SIGMAS,
  flagReach,
  MAX_CHART_SIGMA
} from "../../src/spatial/chart-position";
import type { NodeStore } from "../../src/spatial/node-store";
import type { QueryOptions } from "../../src/spatial/pyramid";
import { mercatorBuffer, REACH_SLACK } from "../../src/spatial/pyramid";
import { REACH_FLAGS } from "../../src/spatial/walk";

/**
 * Graded chart position by brute force (plan §4.3): every leaf of the store
 * beyond the buffer, without pruning, its survey depth's P(UKC < 0) times
 * Φ(−g/σP) and its land's Φ(−g/σT), and its flags within 2σP of its survey.
 * The Mercator-to-ground scale is the walk's, so weights agree to the bit.
 *
 * Survey shadow (`survey-shadow.ts`) by brute force too: S(r) is the widest
 * survey σ of every leaf, the footprint's own included, less than r from the
 * buffer, a leaf with no σ or with a coverage or assessment flag, and a tile
 * outside the chart, reading MAX_CHART_SIGMA; a weight is at most
 * Φ(−max over r ≤ g of r/S(r)), and flags count only where that max is at
 * most FLAG_SIGMAS.
 */
export function referenceChartPosition(
  store: NodeStore,
  geom: Geom,
  opts: QueryOptions
): { maxRisk: number; flags: number } {
  const bounds = geomBounds(geom);
  const bufferMetres = opts.bufferMetres ?? 0;
  const ground = bufferMetres + chartReach(chartSigma(store).max);
  const maxReach = mercatorBuffer(bounds, ground) * REACH_SLACK;
  const perMetre = maxReach / ground;
  // The plain walk's buffer; ground metres past it start from the poleward conversion.
  const buffer = mercatorBuffer(bounds, bufferMetres) * REACH_SLACK;
  const reachBase = perMetre * bufferMetres;
  const area = expandRect(bounds, maxReach);
  const toGround = (d: number): number => Math.max(0, (d - reachBase) / perMetre);
  // Every leaf, and every tile outside the chart, within reach: its ground distance and σ.
  const levels: [number, number][] = [];
  const range = tileRange(store.minZoom, area);
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      if (store.find(store.minZoom, x, y) < 0) {
        const d = geomRectDistance(geom, tileRect(store.minZoom, x, y));
        levels.push([toGround(d), MAX_CHART_SIGMA]);
      }
    }
  }
  for (let z = store.minZoom; z <= store.leafZoom; z++) {
    for (const [x, y, i] of store.entries(z)) {
      if (store.isSplit(i)) {
        continue;
      }
      const d = geomRectDistance(geom, tileRect(z, x, y));
      if (d > maxReach) {
        continue;
      }
      const sigma = store.surveySigma(i);
      const unmodelled = !(sigma > 0) || (store.values(i).flags & REACH_FLAGS) !== 0;
      levels.push([toGround(d), unmodelled ? MAX_CHART_SIGMA : Math.min(sigma, MAX_CHART_SIGMA)]);
    }
  }
  /** max over 0 < r ≤ g of r/S(r), S(r) the widest σ less than r away (MAX_CHART_SIGMA if none). */
  const ratio = (g: number): number => {
    let best = 0;
    for (const r of [g, ...levels.map(([at]) => at).filter((at) => at > 0 && at < g)]) {
      let s = 0;
      for (const [at, sigma] of levels) {
        if (at < r) {
          s = Math.max(s, sigma);
        }
      }
      best = Math.max(best, r / (s > 0 ? s : MAX_CHART_SIGMA));
    }
    return best;
  };
  const shaded = (g: number, weight: number): number =>
    g > 0 ? Math.min(weight, normalCdf(-ratio(g))) : weight;
  let maxRisk = 0;
  let flags = 0;
  for (let z = store.minZoom; z <= store.leafZoom; z++) {
    for (const [x, y, i] of store.entries(z)) {
      if (store.isSplit(i)) {
        continue;
      }
      const rect = tileRect(z, x, y);
      if (
        rect.minX > area.maxX ||
        rect.maxX < area.minX ||
        rect.minY > area.maxY ||
        rect.maxY < area.minY
      ) {
        continue;
      }
      const d = geomRectDistance(geom, rect);
      if (d <= buffer) {
        continue;
      }
      const g = Math.max(0, (d - reachBase) / perMetre);
      const v = store.values(i);
      const survey = store.surveySigma(i);
      if (g <= flagReach(survey) && ratio(g) <= FLAG_SIGMAS) {
        flags |= v.flags;
      }
      if (!opts.risk) {
        continue;
      }
      const bathy = store.bathyDMinOf(i);
      if (survey > 0 && bathy !== Infinity) {
        const p = probabilityBelowZero(
          bathy - opts.risk.threshold,
          Math.hypot(v.sigmaD, opts.risk.sigmaExtra)
        );
        maxRisk = Math.max(maxRisk, p * shaded(g, chartWeight(g, survey)));
      }
      const topo = store.topoSigma(i);
      const drawn = store.topoDMinOf(i);
      if (topo > 0 && drawn !== Infinity) {
        const p =
          drawn === -Infinity
            ? 1
            : probabilityBelowZero(
                drawn - opts.risk.threshold,
                Math.hypot(v.sigmaD, opts.risk.sigmaExtra)
              );
        maxRisk = Math.max(maxRisk, p * shaded(g, chartWeight(g, topo)));
      }
    }
  }
  return { maxRisk, flags };
}
