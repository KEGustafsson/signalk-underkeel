import { tileAt, tileKey, tileRect, toMercator } from "../foundation/geo";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import { minDepthOver } from "../spatial/pyramid";
import type { Sounding } from "./soundings";

/**
 * Per-cell posterior depth (plan §4.13): a Normal–Normal update whose prior
 * is the chart's conservative depth and σ for the cell. Cells are the
 * pyramid's living-chart tiles (z18, ~76 m at 60° N).
 */

export interface CellPosterior {
  z: number;
  x: number;
  y: number;
  /** Chart prior: shallowest charted depth in the cell and its σ, metres. */
  chartDepth: number;
  chartSigma: number;
  cellRef: number;
  mean: number;
  sigma: number;
  samples: number;
  /** Visits separated by more than PASS_GAP_MS. */
  passes: number;
  lastAt: number;
}

/** Samples further apart in time than this belong to different passes. */
export const PASS_GAP_MS = 10 * 60 * 1000;

/** A cell with no charted depth gets this prior σ: the soundings decide alone. */
const NO_PRIOR_SIGMA = 1000;

/** The chart prior for a cell, from the pyramid without living-chart adjustments. */
export function chartPrior(
  store: NodeStore,
  z: number,
  x: number,
  y: number
): { depth: number; sigma: number; cellRef: number } {
  // Inset a little: touching edges count as overlap, and the neighbours are not this cell.
  const t = tileRect(z, x, y);
  const e = (t.maxX - t.minX) * 1e-3;
  const ring = [
    [t.minX + e, t.minY + e],
    [t.maxX - e, t.minY + e],
    [t.maxX - e, t.maxY - e],
    [t.minX + e, t.maxY - e]
  ] as const;
  const v = minDepthOver(
    store,
    { type: "polygon", polygons: [{ outer: ring, holes: [] }] },
    { chartOnly: true }
  );
  const charted = Number.isFinite(v.coveredDMin);
  return {
    depth: charted ? v.coveredDMin : NaN,
    sigma: charted ? Math.max(v.sigmaD, 0.05) : NO_PRIOR_SIGMA,
    cellRef: v.cellRef
  };
}

export class Posteriors {
  readonly cells = new Map<number, CellPosterior>();

  constructor(private readonly store: NodeStore) {}

  cellOf(s: Sounding): { z: number; x: number; y: number } {
    const z = this.store.adjustZoom;
    const [mx, my] = toMercator(s.position[0], s.position[1]);
    return { z, ...tileAt(z, mx, my) };
  }

  /** Folds one sounding into its cell; returns the updated posterior. */
  add(s: Sounding): CellPosterior {
    const { z, x, y } = this.cellOf(s);
    const key = tileKey(z, x, y);
    let c = this.cells.get(key);
    if (!c) {
      const prior = chartPrior(this.store, z, x, y);
      const mean = Number.isNaN(prior.depth) ? s.depth : prior.depth;
      c = {
        z,
        x,
        y,
        chartDepth: prior.depth,
        chartSigma: prior.sigma,
        cellRef: prior.cellRef,
        mean,
        sigma: prior.sigma,
        samples: 0,
        passes: 0,
        lastAt: -Infinity
      };
      this.cells.set(key, c);
    }
    const prec = 1 / c.sigma ** 2 + 1 / s.sigma ** 2;
    c.mean = (c.mean / c.sigma ** 2 + s.depth / s.sigma ** 2) / prec;
    c.sigma = Math.sqrt(1 / prec);
    c.samples += 1;
    if (s.at - c.lastAt > PASS_GAP_MS) {
      c.passes += 1;
    }
    c.lastAt = Math.max(c.lastAt, s.at);
    return c;
  }
}

/** Trigger (plan §4.13): at least this many samples over at least this many passes. */
export const MIN_SAMPLES = 5;
export const MIN_PASSES = 2;

/** The posterior is shallower than the chart by more than 2σ, with enough evidence. */
export function isDiscrepancy(c: CellPosterior): boolean {
  return (
    Number.isFinite(c.chartDepth) &&
    c.samples >= MIN_SAMPLES &&
    c.passes >= MIN_PASSES &&
    c.mean < c.chartDepth - 2 * c.sigma
  );
}

/** The values a discrepancy cell is queried with: shallower than the chart, never deeper. */
export function adjustmentFor(c: CellPosterior, previous?: NodeValues): NodeValues {
  const dMin = Math.min(c.mean, previous?.dMin ?? Infinity, c.chartDepth);
  return {
    dMin,
    sigmaD: Math.max(c.sigma, previous?.sigmaD ?? 0),
    sigmaP: 0,
    flags: FLAGS.LIVECHART_ADJUSTED,
    cellRef: c.cellRef
  };
}
