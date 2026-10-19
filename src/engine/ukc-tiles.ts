import type { Rect } from "../foundation/geo";
import { rectGap, tileRect, tileSize } from "../foundation/geo";
import { probabilityBelowZero } from "../foundation/stats";
import { reachersOf } from "../spatial/chart-position";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { TileCell } from "../spatial/tile-walk";
import { cellsInTile } from "../spatial/tile-walk";
import type { Thresholds } from "./lookahead";

/**
 * UKC overlay (plan §4.10): every pyramid cell in a web-map tile classed by
 * P(UKC < 0) for the current draft and water level. A cell coarser than the
 * drawing resolution is classed by its bound (shallowest depth, widest σ),
 * which never shows a cell safer than any part of it. A cell also takes the
 * class of every cell whose chart reach (2·σP of its assessed survey)
 * reaches it, as a route check or `POST /query` there would.
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

/** Severity of a class reaching a cell, as the look-ahead and query order them. */
const RANK = { clear: 0, caution: 1, unverified: 2, danger: 3 } as const;
const BY_RANK = ["clear", "caution", "unverified", "danger"] as const;

type WaterClass = keyof typeof RANK;

/** Cells per tile side of the reach grid: one per drawing cell at the finest zoom. */
const SLOTS = 2 ** DETAIL_ZOOMS;

/**
 * The worst class reaching each slot of a SLOTS × SLOTS grid over the tile,
 * rows from the north edge. Land reaching a slot reads as danger, since a
 * footprint there would count it.
 */
function reachGrid(
  store: NodeStore,
  tile: Rect,
  z: number,
  input: UkcTileInput
): Uint8Array | undefined {
  const reachers = reachersOf(store, tile, DEFAULT_BUILD.k, z + DETAIL_ZOOMS);
  let grid: Uint8Array | undefined;
  const slot = tileSize(z) / SLOTS;
  const clamp = (v: number): number => Math.max(0, Math.min(SLOTS - 1, Math.floor(v)));
  for (const r of reachers) {
    const cls = classify(r.values, input, r.bound);
    const rank = cls === undefined ? 0 : cls === "land" ? RANK.danger : RANK[cls];
    if (rank === 0) {
      continue;
    }
    grid ??= new Uint8Array(SLOTS * SLOTS);
    const i0 = clamp((r.rect.minX - r.reach - tile.minX) / slot);
    const i1 = clamp((r.rect.maxX + r.reach - tile.minX) / slot);
    const j0 = clamp((tile.maxY - r.rect.maxY - r.reach) / slot);
    const j1 = clamp((tile.maxY - r.rect.minY + r.reach) / slot);
    for (let j = j0; j <= j1; j++) {
      const maxY = tile.maxY - j * slot;
      for (let i = i0; i <= i1; i++) {
        const k = j * SLOTS + i;
        if ((grid[k] as number) >= rank) {
          continue;
        }
        const minX = tile.minX + i * slot;
        const s = { minX, minY: maxY - slot, maxX: minX + slot, maxY };
        if (rectGap(s, r.rect) <= r.reach) {
          grid[k] = rank;
        }
      }
    }
  }
  return grid;
}

/**
 * Rectangles for one cell: whole when nothing worse reaches it, else one per
 * reach slot, each with the worse of its own class and the slot's.
 */
function cellRects(
  c: TileCell,
  cls: UkcClass,
  z: number,
  x: number,
  y: number,
  extent: number,
  grid: Uint8Array | undefined
): UkcRect[] {
  const scale = 2 ** (c.z - z);
  const size = extent / scale;
  const x0 = (c.x - x * scale) * size;
  const y0 = (c.y - y * scale) * size;
  const whole = [{ class: cls, x0, y0, x1: x0 + size, y1: y0 + size }];
  if (!grid || cls === "land") {
    return whole;
  }
  const own = RANK[cls as WaterClass];
  const n = SLOTS / scale;
  const si = (c.x - x * scale) * n;
  const sj = (c.y - y * scale) * n;
  let worse = false;
  for (let j = sj; j < sj + n && !worse; j++) {
    for (let i = si; i < si + n && !worse; i++) {
      worse = (grid[j * SLOTS + i] as number) > own;
    }
  }
  if (!worse) {
    return whole;
  }
  const step = extent / SLOTS;
  const out: UkcRect[] = [];
  for (let j = sj; j < sj + n; j++) {
    for (let i = si; i < si + n; i++) {
      const rank = Math.max(own, grid[j * SLOTS + i] as number);
      const sx = i * step;
      const sy = j * step;
      out.push({ class: BY_RANK[rank] as UkcClass, x0: sx, y0: sy, x1: sx + step, y1: sy + step });
    }
  }
  return out;
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
  const grid = reachGrid(store, tileRect(z, x, y), z, input);
  const rects: UkcRect[] = [];
  for (const c of cellsInTile(store, z, x, y, z + DETAIL_ZOOMS)) {
    const cls = classify(c.values, input, c.bound);
    if (cls !== undefined) {
      rects.push(...cellRects(c, cls, z, x, y, extent, grid));
    }
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
