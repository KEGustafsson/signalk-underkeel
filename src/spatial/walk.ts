import type { Rect, XY } from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { probabilityBelowZero } from "../foundation/stats";
import type { ChartReach } from "./pyramid";
import type { NodeStore, NodeValues, StandIn } from "./node-store";
import { FLAGS } from "./node-store";

/**
 * The state of one `minDepthOver` walk (`pyramid.ts`) and how a tile's
 * values fold into it.
 */

export interface Walk {
  store: NodeStore;
  geom: Geom;
  /** Bounds of `geom`, and a point of it when it has one. */
  bounds: Rect;
  /** `bounds` grown by `buffer`: every tile within the buffer of the footprint lies in it. */
  hold: Rect;
  vertex?: XY;
  /** Mercator reach of a tile without chart position, and of any tile at most. */
  buffer: number;
  /**
   * The buffer converted at the poleward edge of the widest reach, `perMetre` × the ground
   * buffer: never less than `buffer`. Reaches and ground metres past the buffer start here.
   */
  reachBase: number;
  maxReach: number;
  /** Mercator metres per ground metre of chart reach, at the poleward edge of the reach. */
  perMetre: number;
  graded: boolean;
  clearAbove: number;
  /** Folded in place by `take`; never one of the shared constants. */
  result: NodeValues;
  /** Scratch bounds of the tile being visited. */
  rect: Rect;
  coveredDMin: number;
  cells: Set<number>;
  worst?: { z: number; x: number; y: number };
  visits: number;
  risk?: { threshold: number; sigmaExtra: number };
  maxRisk: number;
  riskTile?: {
    v: NodeValues;
    z: number;
    x: number;
    y: number;
    risk: number;
    chart?: Omit<ChartReach, "extent">;
  };
  stopWhenCertain: boolean;
}

/** Folds a tile's depth, σ, flags and cell into the result. */
export function fold(w: Walk, v: NodeValues, flags: number, z: number, x: number, y: number): void {
  const r = w.result;
  if (v.dMin < r.dMin || w.worst === undefined) {
    w.worst = { z, x, y };
  }
  // combine() folded in place: a tick takes thousands of tiles.
  if (v.dMin < r.dMin) {
    r.dMin = v.dMin;
    r.cellRef = v.cellRef;
  }
  r.sigmaD = Math.max(r.sigmaD, v.sigmaD);
  r.sigmaP = Math.max(r.sigmaP, v.sigmaP);
  r.flags |= flags;
  if (v.cellRef >= 0) {
    w.cells.add(v.cellRef);
  }
}

/**
 * The flags a tile beyond the buffer passes to the footprint within its survey's flag reach:
 * a gap, an unassessed survey or advisory water nearby keeps it from reading as safe
 * (invariant 4). A flag that describes a place, swept or dredged, holds only where its area
 * is, and a split tile carries it for any child, so it is not taken from beyond the buffer.
 */
export const REACH_FLAGS =
  FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

/** Folds the reach flags, σP and cell of a tile beyond the buffer, within its flag reach. */
export function foldFlags(w: Walk, v: NodeValues, flags: number): void {
  const r = w.result;
  r.sigmaP = Math.max(r.sigmaP, v.sigmaP);
  r.flags |= flags & REACH_FLAGS;
  if (v.cellRef >= 0) {
    w.cells.add(v.cellRef);
  }
}

/** P(UKC < 0) of a charted depth with its σD. */
export function riskAt(w: Walk, dMin: number, sigmaD: number): number {
  const r = w.risk as { threshold: number; sigmaExtra: number };
  return probabilityBelowZero(dMin - r.threshold, Math.hypot(sigmaD, r.sigmaExtra));
}

/** Counts a charted tile's P(UKC < 0) from its dMin and σD. */
export function weigh(w: Walk, t: NodeValues, z: number, x: number, y: number): void {
  if (w.risk) {
    const risk = riskAt(w, t.dMin, t.sigmaD);
    if (w.riskTile === undefined || risk > w.riskTile.risk) {
      w.riskTile = { v: t, z, x, y, risk };
      w.maxRisk = risk;
    }
  }
}

export function take(w: Walk, v: NodeValues, z: number, x: number, y: number): void {
  fold(w, v, v.flags, z, x, y);
  if ((v.flags & FLAGS.NO_DEPTH) === 0) {
    w.coveredDMin = Math.min(w.coveredDMin, v.dMin);
    weigh(w, v, z, x, y);
  }
}

/**
 * Takes a split tile whose children are in a block not loaded, as no
 * coverage and with bounds no loaded child could exceed: its own shallowest
 * depth, widest σ and flags, the shallowest charted depth under it, and a
 * risk at least any charted child's. Below the threshold a child's P is
 * highest at its least σ, above it at its widest, so the stand-in's σ is
 * picked by the side its charted depth is on.
 */
export function takeStandIn(
  w: Walk,
  v: NodeValues,
  s: StandIn,
  z: number,
  x: number,
  y: number
): void {
  const flags = v.flags | FLAGS.NO_COVERAGE;
  fold(w, v, flags, z, x, y);
  if (s.covered === Infinity) {
    return;
  }
  w.coveredDMin = Math.min(w.coveredDMin, s.covered);
  const below = w.risk !== undefined && s.covered < w.risk.threshold;
  weigh(w, { ...v, dMin: s.covered, sigmaD: below ? s.sigmaDMin : v.sigmaD, flags }, z, x, y);
}

export function certain(w: Walk): boolean {
  return w.maxRisk >= 1 && w.coveredDMin === -Infinity && w.result.dMin === -Infinity;
}
