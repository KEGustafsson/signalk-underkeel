import type { Rect } from "../foundation/geo";
import { rectGap, tileRect, tileSize } from "../foundation/geo";
import { normalCdf, probabilityBelowZero } from "../foundation/stats";
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
 * Thresholds, metres, at all of which a tile is drawn the same, both ends
 * included; the other inputs held. A tile drawn at a threshold inside the
 * range is byte for byte the tile drawn at any other inside it.
 */
export interface ThresholdRange {
  lo: number;
  hi: number;
}

/**
 * The class of one cell, or undefined outside every chart. A bound cell
 * (`bound`) whose shallowest part is land or a gap may also hold charted
 * water, so it is drawn as danger or unverified, never hidden.
 */
export function classify(v: NodeValues, input: UkcTileInput, bound = false): UkcClass | undefined {
  return classed(v, input, bound, undefined);
}

/**
 * P rises with the threshold (invariant 2), so one class holds from the
 * threshold where P crosses a level to the next such threshold. `range`,
 * when given, is narrowed to those around the input's.
 */
function classed(
  v: NodeValues,
  input: UkcTileInput,
  bound: boolean,
  range: ThresholdRange | undefined
): UkcClass | undefined {
  if (v.dMin === -Infinity) {
    if (bound) {
      return v.flags & FLAGS.NO_COVERAGE ? "unverified" : "danger";
    }
    return v.flags & FLAGS.NO_COVERAGE ? undefined : "land";
  }
  const t = input.threshold;
  // Past the threshold a wider σ lowers P, so a bound's widest σ no longer
  // bounds its children's P from above: some child is at P ≥ 0.5.
  if (bound && v.dMin <= t) {
    if (range) {
      range.lo = Math.max(range.lo, v.dMin);
    }
    return "danger";
  }
  const sigma = Math.hypot(v.sigmaD, input.sigmaExtra);
  const risk = probabilityBelowZero(v.dMin - t, sigma);
  const { warn, alert } = input.thresholds;
  if (range) {
    narrowAll(range, v, bound, input, sigma, risk);
  }
  if (risk >= warn) {
    return "danger";
  }
  if (v.flags & UNVERIFIED) {
    return "unverified";
  }
  if (risk >= alert) {
    return "caution";
  }
  return input.degraded ? "unverified" : "clear";
}

/** The levels this cell's class changes at: warn, alert unless unverified, and dMin for a bound. */
function narrowAll(
  range: ThresholdRange,
  v: NodeValues,
  bound: boolean,
  input: UkcTileInput,
  sigma: number,
  risk: number
): void {
  const t = input.threshold;
  const { warn, alert } = input.thresholds;
  narrow(range, v.dMin, sigma, t, risk, warn);
  if (!(v.flags & UNVERIFIED)) {
    narrow(range, v.dMin, sigma, t, risk, alert);
  }
  if (bound && risk < warn) {
    range.hi = Math.min(range.hi, Math.max(t, v.dMin - SLACK));
  }
}

/** Metres kept clear of a threshold where P crosses a level: far beyond its rounding error. */
const SLACK = 1e-6;

const CROSSINGS = new Map<number, number>();

/** The least x with normalCdf(x) ≥ p, searched on normalCdf itself rather than an inverse. */
function crossing(p: number): number {
  let x = CROSSINGS.get(p);
  if (x === undefined) {
    let lo = -40;
    let hi = 40;
    for (let mid = (lo + hi) / 2; mid !== lo && mid !== hi; mid = (lo + hi) / 2) {
      if (normalCdf(mid) >= p) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    x = hi;
    CROSSINGS.set(p, x);
  }
  return x;
}

/**
 * Narrows `range` to the side of level `p` that threshold `t` is on. The
 * crossing is dMin + x·σ; with σ 0, P steps from 0 to 1 at dMin. A side
 * reaches at least to `t`, since P is monotonic in the threshold.
 */
function narrow(
  range: ThresholdRange,
  dMin: number,
  sigma: number,
  t: number,
  risk: number,
  p: number
): void {
  const at = dMin + (sigma > 0 ? crossing(p) * sigma : 0);
  if (risk >= p) {
    range.lo = Math.max(range.lo, Math.min(t, at + SLACK));
  } else {
    range.hi = Math.min(range.hi, Math.max(t, at - SLACK));
  }
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
  input: UkcTileInput,
  range: ThresholdRange | undefined
): Uint8Array | undefined {
  const reachers = reachersOf(store, tile, DEFAULT_BUILD.k, z + DETAIL_ZOOMS);
  let grid: Uint8Array | undefined;
  const slot = tileSize(z) / SLOTS;
  const clamp = (v: number): number => Math.max(0, Math.min(SLOTS - 1, Math.floor(v)));
  for (const r of reachers) {
    const cls = classed(r.values, input, r.bound, range);
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
  return drawTile(store, z, x, y, extent, input, undefined);
}

/** ukcTile and the thresholds over which it is drawn the same. */
export function ukcTileWithRange(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  extent: number,
  input: UkcTileInput
): { rects: UkcRect[]; range: ThresholdRange } {
  const range = { lo: -Infinity, hi: Infinity };
  return { rects: drawTile(store, z, x, y, extent, input, range), range };
}

function drawTile(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  extent: number,
  input: UkcTileInput,
  range: ThresholdRange | undefined
): UkcRect[] {
  const grid = reachGrid(store, tileRect(z, x, y), z, input, range);
  const rects: UkcRect[] = [];
  for (const c of cellsInTile(store, z, x, y, z + DETAIL_ZOOMS)) {
    const cls = classed(c.values, input, c.bound, range);
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
