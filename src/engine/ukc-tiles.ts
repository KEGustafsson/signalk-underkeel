import { probabilityBelowZero } from "../foundation/stats";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import { cellsInTile } from "../spatial/tile-walk";
import type { Thresholds } from "./lookahead";

/**
 * UKC overlay (plan §4.10): every pyramid cell in a web-map tile classed by
 * P(UKC < 0) for the current draft and water level. A cell coarser than the
 * drawing resolution is classed by its bound (shallowest depth, widest σ),
 * which never shows a cell safer than any part of it.
 */

export type UkcClass = "clear" | "caution" | "danger" | "unverified" | "land";

export interface UkcRect {
  class: UkcClass;
  /** Tile extent units, y down. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface UkcTileInput {
  threshold: number;
  sigmaExtra: number;
  thresholds: Thresholds;
  /** The water level is a fallback: nothing is drawn as clear. */
  degraded: boolean;
}

/** Cells per tile side at most: 2^6 = 64. */
export const DETAIL_ZOOMS = 6;

const UNVERIFIED = FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

/**
 * The class of one cell, or undefined outside every chart. A bound cell
 * (`bound`) whose shallowest part is land or a gap may also hold charted
 * water, so it is drawn as danger or unverified, never hidden.
 */
export function classify(v: NodeValues, input: UkcTileInput, bound = false): UkcClass | undefined {
  if (v.dMin === -Infinity) {
    if (bound) {
      return v.flags & FLAGS.NO_COVERAGE ? "unverified" : "danger";
    }
    return v.flags & FLAGS.NO_COVERAGE ? undefined : "land";
  }
  // Past the threshold a wider σ lowers P, so a bound's widest σ no longer
  // bounds its children's P from above: some child is at P ≥ 0.5.
  if (bound && v.dMin <= input.threshold) {
    return "danger";
  }
  const risk = probabilityBelowZero(
    v.dMin - input.threshold,
    Math.hypot(v.sigmaD, input.sigmaExtra)
  );
  if (risk >= input.thresholds.warn) {
    return "danger";
  }
  if (v.flags & UNVERIFIED) {
    return "unverified";
  }
  if (risk >= input.thresholds.alert) {
    return "caution";
  }
  return input.degraded ? "unverified" : "clear";
}

/** Classed rectangles for tile (z, x, y), runs of equal class merged along rows. */
export function ukcTile(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  extent: number,
  input: UkcTileInput
): UkcRect[] {
  const rects: UkcRect[] = [];
  for (const c of cellsInTile(store, z, x, y, z + DETAIL_ZOOMS)) {
    const cls = classify(c.values, input, c.bound);
    if (cls === undefined) {
      continue;
    }
    const scale = 2 ** (c.z - z);
    const size = extent / scale;
    const x0 = (c.x - x * scale) * size;
    const y0 = (c.y - y * scale) * size;
    rects.push({ class: cls, x0, y0, x1: x0 + size, y1: y0 + size });
  }
  rects.sort((a, b) =>
    a.class !== b.class ? (a.class < b.class ? -1 : 1) : a.y0 - b.y0 || a.y1 - b.y1 || a.x0 - b.x0
  );
  const merged: UkcRect[] = [];
  for (const r of rects) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.class === r.class &&
      last.y0 === r.y0 &&
      last.y1 === r.y1 &&
      last.x1 === r.x0
    ) {
      last.x1 = r.x1;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}
