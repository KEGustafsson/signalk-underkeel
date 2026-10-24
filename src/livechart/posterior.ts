import { tileAt, tileKey, tileRect, toMercator } from "../foundation/geo";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import { minDepthOver } from "../spatial/pyramid";
import { unloadedBlock } from "./chart-blocks";
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
  /**
   * The most σ the posterior has read shallower than a charted prior, (chartDepth − mean)/σ,
   * from its first sample on; never lowered, and absent while it never had one. It survives a
   * rebase onto a chart that does not chart the cell, as after the index box moves away.
   */
  peakZ?: number;
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
  /**
   * Keys of the cells, and of adjustments without one, whose prior or cell reference was read
   * while their block was not loaded (plan §4.13), to be moved onto the loaded chart. Until
   * then a cell holds the stand-ins' prior, never deeper than the chart, or noPrior().
   */
  readonly unsettled: Set<number> = new Set<number>();

  constructor(private store: NodeStore) {}

  /** Reads chart priors from a rebuilt index from now on. */
  rebind(store: NodeStore): void {
    this.store = store;
  }

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
      // Read after the prior: a small block is read on the spot by the query that reaches it.
      if (unloadedBlock(this.store, z, x, y) !== undefined) {
        this.unsettled.add(key);
      }
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
    const peak = shoalZ(c);
    if (peak > (c.peakZ ?? -Infinity)) {
      c.peakZ = peak;
    }
    return c;
  }

  /**
   * Bounds the cells kept (plan §4.13) and returns how many it dropped. A cell with an
   * adjustment or waiting for its chart block is never dropped. Shoals still gathering their
   * evidence (`gathering`) and the other cells are bounded apart: once more than `max` of one
   * kind could be dropped, those last sounded longest ago go until `low` remain. So a shoal
   * keeps its evidence among ordinary cells, and a steady error that marks every cell of a
   * passage still cannot grow them without end. A dropped cell sounded again starts from the
   * chart.
   */
  prune(max: number, low: number): number {
    if (this.cells.size <= max) {
      return 0;
    }
    const plain: [number, number][] = [];
    const shoals: [number, number][] = [];
    for (const [key, c] of this.cells) {
      if (!this.store.adjustments.has(key) && !this.unsettled.has(key)) {
        (gathering(c) ? shoals : plain).push([c.lastAt, key]);
      }
    }
    return this.dropOldest(plain, max, low) + this.dropOldest(shoals, max, low);
  }

  /** Past `max`, drops the oldest-sounded of `kind` ([lastAt, key]) until `low` remain. */
  private dropOldest(kind: [number, number][], max: number, low: number): number {
    if (kind.length <= max) {
      return 0;
    }
    kind.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const drop = kind.length - low;
    for (const [, key] of kind.slice(0, drop)) {
      this.cells.delete(key);
    }
    return drop;
  }
}

/** A cell that has read this many σ shallower than a charted prior is marked as a shoal. */
export const PROTECT_Z = 1;

/** How many σ the posterior reads shallower than its prior; -Infinity without a charted one. */
export function shoalZ(c: CellPosterior): number {
  return Number.isFinite(c.chartDepth) && c.samples > 0
    ? (c.chartDepth - c.mean) / c.sigma
    : -Infinity;
}

/** `c` with its peakZ raised to its shoalZ() when that is higher. */
export function withPeak(c: CellPosterior): CellPosterior {
  const z = shoalZ(c);
  return z > (c.peakZ ?? -Infinity) ? { ...c, peakZ: z } : c;
}

/** The cell has read PROTECT_Z or more shallower than a charted prior, at some time. */
export const isProtectedMark = (c?: CellPosterior): boolean => (c?.peakZ ?? -Infinity) >= PROTECT_Z;

/**
 * A shoal waiting for its evidence: it has read PROTECT_Z or more shallower than a charted prior
 * and has not yet had MIN_SAMPLES samples over MIN_PASSES passes to be judged with.
 */
export const gathering = (c: CellPosterior): boolean =>
  isProtectedMark(c) && (c.samples < MIN_SAMPLES || c.passes < MIN_PASSES);

/** A rebase marked the cell protected: its line must be saved so the mark survives a cut. */
export const raisedMark = (before: CellPosterior | undefined, after: CellPosterior): boolean =>
  !isProtectedMark(before) && isProtectedMark(after);

/**
 * Moves a posterior onto another chart prior, for a saved cell meeting a rebuilt index:
 * the old prior's precision and weighted depth come out, the new prior's go in, and the
 * soundings' evidence stays. An uncharted prior carries no weight.
 */
export function rebasePrior(
  c: CellPosterior,
  prior: { depth: number; sigma: number; cellRef: number }
): CellPosterior {
  // Unchanged, without the rounding a round trip through the precisions would add.
  if (
    Object.is(prior.depth, c.chartDepth) &&
    prior.sigma === c.chartSigma &&
    prior.cellRef === c.cellRef
  ) {
    return c;
  }
  const oldP = Number.isFinite(c.chartDepth) ? 1 / c.chartSigma ** 2 : 0;
  const newP = Number.isFinite(prior.depth) ? 1 / prior.sigma ** 2 : 0;
  const evidenceP = 1 / c.sigma ** 2 - oldP;
  const evidenceW = c.mean / c.sigma ** 2 - (oldP > 0 ? c.chartDepth * oldP : 0);
  const rebased = {
    ...c,
    chartDepth: prior.depth,
    chartSigma: prior.sigma,
    cellRef: prior.cellRef
  };
  if (!(evidenceP > 0)) {
    return withPeak({ ...rebased, mean: newP > 0 ? prior.depth : c.mean, sigma: prior.sigma });
  }
  const prec = evidenceP + newP;
  return withPeak({
    ...rebased,
    mean: (evidenceW + (newP > 0 ? prior.depth * newP : 0)) / prec,
    sigma: Math.sqrt(1 / prec)
  });
}

/**
 * The prior of a cell whose chart cannot be read yet: none, so the soundings stand alone and
 * the cell is not judged until it is rebased onto its chart. Its cell reference is -1, no
 * cell: a reference kept from another index would name whatever cell that number has in the
 * current catalogue, in query results and explanations.
 */
export const noPrior = (): { depth: number; sigma: number; cellRef: number } => ({
  depth: NaN,
  sigma: NO_PRIOR_SIGMA,
  cellRef: -1
});

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
