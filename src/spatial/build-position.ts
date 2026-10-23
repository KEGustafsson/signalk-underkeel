import { compilationSigma } from "../ingest/cells";
import type { ChartFeature } from "../ingest/features";
import type { BuildOptions } from "./build-items";
import type { ChartPosition, NodeValues } from "./node-values";
import { FLAGS } from "./node-values";
import { sigmaFor } from "./quality";

/**
 * What each pyramid node spreads by its chart position (plan §4.3): the σ of
 * its survey with the shallowest depth the survey places (soundings and
 * point dangers), and the σ of the chart's own drawing with the shallowest
 * depth it places (land, shoreline and depth areas).
 */

/**
 * A spatial record that is not surveyed (QUAPOS approximate, estimated …) is
 * read as drawn from a source this many times smaller in scale: the step
 * between usage bands. At 1:12 000 that is 24 m (1σ).
 */
export const NOT_SURVEYED_SCALE = 4;

/** A feature reaching a tile, as the build classes it. */
interface Reaching {
  item: { f: ChartFeature };
}

const depthOf = (f: ChartFeature): number | undefined =>
  f.role === "depth" || f.role === "swept" ? f.depth : undefined;

export const NO_POSITION: ChartPosition = {
  surveySigmaP: 0,
  topoSigmaP: 0,
  bathyDMin: Infinity,
  topoDMin: Infinity
};

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
 * What a leaf spreads by its chart position (plan §4.3). Land, shoreline and
 * depth areas with a σ of their own (`DepthFeature.topoSigma`) are left out
 * of the depth the survey places and spread by that σ instead, widened where
 * a record under them is not surveyed (`NOT_SURVEYED_SCALE`; the survey's σ,
 * or the unassessed one, for a cell with no compilation scale) and to half a
 * stated POSACC. Soundings and point dangers are placed by the survey.
 */
export function chartPosition(hits: Reaching[], v: NodeValues, opts: BuildOptions): ChartPosition {
  const surveySigmaP = surveySigma(hits, opts);
  if (v.flags & FLAGS.NO_DEPTH) {
    return { ...NO_POSITION, surveySigmaP };
  }
  let topo = 0;
  let topoD = Infinity;
  let bathy = Infinity;
  for (const h of hits) {
    const f = h.item.f;
    const d = depthOf(f);
    if (f.role === "depth" && f.topoSigma !== undefined) {
      topo = Math.max(topo, f.topoSigma);
      topoD = Math.min(topoD, f.depth);
    } else if (d !== undefined) {
      bathy = Math.min(bathy, d);
    }
  }
  if (topo === 0) {
    return { surveySigmaP, topoSigmaP: 0, bathyDMin: v.dMin, topoDMin: Infinity };
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
        const drawn =
          f.scale === undefined ? unsurveyed : NOT_SURVEYED_SCALE * compilationSigma(f.scale);
        topo = Math.max(topo, drawn);
      }
    }
  }
  return { surveySigmaP, topoSigmaP: topo, bathyDMin: bathy, topoDMin: topoD };
}
