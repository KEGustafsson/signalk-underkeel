/**
 * The values every pyramid node carries (plan §4.3), and how they combine.
 * `node-store.ts` keeps them in columns and re-exports these.
 */

/** Bit flags carried by every pyramid node (plan §4.3). Parents OR their children's. */
export const FLAGS = {
  SWEPT: 1,
  NO_COVERAGE: 2,
  UNASSESSED: 4,
  DREDGED: 8,
  LIVECHART_ADJUSTED: 16,
  /** No charted depth at all in (part of) the tile; dMin is -Infinity there. */
  NO_DEPTH: 32,
  /** Set from a source licensed for non-navigational use only (the Traficom WFS). */
  NOT_FOR_NAVIGATION: 64
} as const;

const FLAG_NAMES: [number, string][] = [
  [FLAGS.SWEPT, "SWEPT"],
  [FLAGS.NO_COVERAGE, "NO_COVERAGE"],
  [FLAGS.UNASSESSED, "UNASSESSED"],
  [FLAGS.DREDGED, "DREDGED"],
  [FLAGS.LIVECHART_ADJUSTED, "LIVECHART_ADJUSTED"],
  [FLAGS.NOT_FOR_NAVIGATION, "NOT_FOR_NAVIGATION"]
];

/** Names of the flags a client should see (NO_DEPTH is internal). */
export function flagNames(flags: number): string[] {
  return FLAG_NAMES.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
}

export interface NodeValues {
  /** Conservative depth below chart datum (m); -Infinity for land or no data. */
  dMin: number;
  sigmaD: number;
  sigmaP: number;
  flags: number;
  /** Cell catalogue index of the feature that set dMin; -1 when none. */
  cellRef: number;
}

export const NO_DATA: NodeValues = {
  dMin: -Infinity,
  sigmaD: 0,
  sigmaP: 0,
  flags: FLAGS.NO_COVERAGE | FLAGS.NO_DEPTH,
  cellRef: -1
};

/** Folds `b` into `a`: the shallowest depth, the widest σ, the union of flags. */
export function combine(a: NodeValues, b: NodeValues): NodeValues {
  const deeper = b.dMin < a.dMin ? b : a;
  return {
    dMin: deeper.dMin,
    cellRef: deeper.cellRef,
    sigmaD: Math.max(a.sigmaD, b.sigmaD),
    sigmaP: Math.max(a.sigmaP, b.sigmaP),
    flags: a.flags | b.flags
  };
}

/** Identity element for `combine`. */
export const EMPTY: NodeValues = {
  dMin: Infinity,
  sigmaD: 0,
  sigmaP: 0,
  flags: 0,
  cellRef: -1
};

/**
 * What a node spreads beyond itself by its chart position (`chart-position.ts`).
 * A split node holds its subtree's widest σ and shallowest depth.
 */
export interface ChartPosition {
  /** Widest assessed survey σP, metres (`NodeStore.surveySigmaP`). */
  surveySigmaP: number;
  /** Widest σ of its land and shoreline objects' own positions, metres; 0 when none. */
  topoSigmaP: number;
  /**
   * Shallowest depth of what the survey places: every depth feature but land
   * and shoreline objects placed by their own σ. Infinity when none, and for
   * a tile with no depth (it adds no risk; its flags count).
   */
  bathyDMin: number;
}

/** The chart position of a parent from its children's: the widest σ, the shallowest depth. */
export function joinPosition(a: ChartPosition, b: ChartPosition): ChartPosition {
  return {
    surveySigmaP: Math.max(a.surveySigmaP, b.surveySigmaP),
    topoSigmaP: Math.max(a.topoSigmaP, b.topoSigmaP),
    bathyDMin: Math.min(a.bathyDMin, b.bathyDMin)
  };
}

/** A node that places every depth it holds, land included, by its survey alone. */
export function surveyOnly(v: NodeValues, surveySigmaP: number): ChartPosition {
  return {
    surveySigmaP,
    topoSigmaP: 0,
    bathyDMin: v.flags & FLAGS.NO_DEPTH ? Infinity : v.dMin
  };
}
