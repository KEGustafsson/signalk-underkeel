import type { ChartFeature } from "../ingest/features";
import type { BuildOptions } from "./build-items";
import type { ChartPosition, NodeValues } from "./node-values";
import { FLAGS } from "./node-values";
import { sigmaFor } from "./quality";

/**
 * What each pyramid node spreads by its chart position (plan §4.3): the σ of
 * its survey, the σ of its land and shoreline objects' own positions, and
 * the shallowest depth its survey places.
 */

/** A feature reaching a tile, as the build classes it. */
interface Reaching {
  item: { f: ChartFeature };
}

const depthOf = (f: ChartFeature): number | undefined =>
  f.role === "depth" || f.role === "swept" ? f.depth : undefined;

export const NO_POSITION: ChartPosition = { surveySigmaP: 0, topoSigmaP: 0, bathyDMin: Infinity };

/**
 * Chart position σP of a leaf: the widest of the assessed, non-advisory
 * quality zones reaching it, however much of it they cover.
 */
function surveySigma(hits: Reaching[], opts: BuildOptions): number {
  let sigmaP = 0;
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "quality" && f.catzoc !== 6 && !f.advisory) {
      sigmaP = Math.max(sigmaP, sigmaFor(f.catzoc, 0, f, opts.quality).sigmaP);
    }
  }
  return sigmaP;
}

/**
 * What a leaf spreads by its chart position (plan §4.3). Land and shoreline
 * objects with a σ of their own (`DepthFeature.topoSigma`) are left out of
 * the depth the survey places and spread by that σ instead, widened to the
 * survey's σ (or the unassessed one) where a record under them is not
 * surveyed, and to half a stated POSACC.
 */
export function chartPosition(hits: Reaching[], v: NodeValues, opts: BuildOptions): ChartPosition {
  const surveySigmaP = surveySigma(hits, opts);
  if (v.flags & FLAGS.NO_DEPTH) {
    return { surveySigmaP, topoSigmaP: 0, bathyDMin: Infinity };
  }
  let topo = 0;
  let bathy = Infinity;
  for (const h of hits) {
    const f = h.item.f;
    const d = depthOf(f);
    if (f.role === "depth" && f.topoSigma !== undefined) {
      topo = Math.max(topo, f.topoSigma);
    } else if (d !== undefined) {
      bathy = Math.min(bathy, d);
    }
  }
  if (topo === 0) {
    return { surveySigmaP, topoSigmaP: 0, bathyDMin: v.dMin };
  }
  const unsurveyed =
    surveySigmaP > 0 ? surveySigmaP : sigmaFor(undefined, 0, {}, opts.quality).sigmaP;
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "position") {
      if (f.posacc !== undefined) {
        topo = Math.max(topo, f.posacc / 2);
      }
      if (f.lowAccuracy) {
        topo = Math.max(topo, unsurveyed);
      }
    }
  }
  return { surveySigmaP, topoSigmaP: topo, bathyDMin: bathy };
}
