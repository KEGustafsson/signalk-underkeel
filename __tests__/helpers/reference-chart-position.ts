import { expandRect, tileRect } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import { geomBounds, geomRectDistance } from "../../src/foundation/geometry";
import { probabilityBelowZero } from "../../src/foundation/stats";
import { chartReach, chartSigma, chartWeight, flagReach } from "../../src/spatial/chart-position";
import type { NodeStore } from "../../src/spatial/node-store";
import type { QueryOptions } from "../../src/spatial/pyramid";
import { mercatorBuffer, REACH_SLACK } from "../../src/spatial/pyramid";

/**
 * Graded chart position by brute force (plan §4.3): every leaf of the store
 * beyond the buffer, without pruning, its survey depth's P(UKC < 0) times
 * Φ(−g/σP) and its land's Φ(−g/σT), and its flags within 2σP of its survey.
 * The Mercator-to-ground scale is the walk's, so weights agree to the bit.
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
      if (g <= flagReach(survey)) {
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
        maxRisk = Math.max(maxRisk, p * chartWeight(g, survey));
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
        maxRisk = Math.max(maxRisk, p * chartWeight(g, topo));
      }
    }
  }
  return { maxRisk, flags };
}
