import { normalCdf, probabilityBelowZero } from "../foundation/stats";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import type { Thresholds } from "./lookahead";
import type { TileGeometry, UkcTileCache } from "./ukc-tile-geometry";
import { DETAIL_ZOOMS, MASK_WORDS, SLOTS, tileGeometry } from "./ukc-tile-geometry";

export { DETAIL_ZOOMS };

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

/**
 * The worst rank reaching each slot of the reach grid, from the rank of each
 * kind. Land reaching a slot reads as danger, since a footprint there would
 * count it.
 */
function reachGrid(g: TileGeometry, ranks: Uint8Array): Uint8Array | undefined {
  let grid: Uint8Array | undefined;
  for (let m = 0; m < g.reachKind.length; m++) {
    const rank = ranks[g.reachKind[m] as number] as number;
    if (rank === 0) {
      continue;
    }
    grid ??= new Uint8Array(SLOTS * SLOTS);
    for (let w = 0; w < MASK_WORDS; w++) {
      let bits = (g.reachMask[m * MASK_WORDS + w] as number) | 0;
      while (bits !== 0) {
        const low = bits & -bits;
        const k = w * 32 + 31 - Math.clz32(low);
        if ((grid[k] as number) < rank) {
          grid[k] = rank;
        }
        bits ^= low;
      }
    }
  }
  return grid;
}

/** Classes in the order the drawn rectangles are sorted by: their names' order. */
const BY_NAME: UkcClass[] = ["caution", "clear", "danger", "land", "unverified"];
const NAME_ORDER = new Map(BY_NAME.map((c, i) => [c, i]));
const RANK_NAME = BY_RANK.map((c) => NAME_ORDER.get(c) as number);

/** Rectangles as columns, reused across tiles: `cls` is the index in BY_NAME. */
class RectColumns {
  n = 0;
  cls = new Uint8Array(0);
  x0 = new Float64Array(0);
  y0 = new Float64Array(0);
  x1 = new Float64Array(0);
  y1 = new Float64Array(0);
  order = new Uint32Array(0);
  key = new Float64Array(0);

  /** Empties the columns, with room for `cap` rectangles. */
  reset(cap: number): void {
    this.n = 0;
    if (this.cls.length < cap) {
      Object.assign(this, {
        cls: new Uint8Array(cap),
        x0: new Float64Array(cap),
        y0: new Float64Array(cap),
        x1: new Float64Array(cap),
        y1: new Float64Array(cap),
        order: new Uint32Array(cap),
        key: new Float64Array(cap)
      });
    }
  }

  push(cls: number, x0: number, y0: number, size: number): void {
    const i = this.n++;
    this.cls[i] = cls;
    this.x0[i] = x0;
    this.y0[i] = y0;
    this.x1[i] = x0 + size;
    this.y1[i] = y0 + size;
  }
}

const scratch = new RectColumns();

/** Rectangles a sort key can index: SLOTS² slot rectangles and as many cells. */
const INDEX_SPAN = 2 * SLOTS * SLOTS;

/**
 * Rectangles for cell c: whole when nothing worse reaches it, else one per
 * reach slot, each with the worse of its own class and the slot's.
 */
function cellRects(
  out: RectColumns,
  g: TileGeometry,
  c: number,
  cls: UkcClass,
  extent: number,
  grid: Uint8Array | undefined
): void {
  const scale = 2 ** (g.cellZ[c] as number);
  const cx = g.cellX[c] as number;
  const cy = g.cellY[c] as number;
  const size = extent / scale;
  const name = NAME_ORDER.get(cls) as number;
  if (!grid || cls === "land") {
    out.push(name, cx * size, cy * size, size);
    return;
  }
  const own = RANK[cls as WaterClass];
  const n = SLOTS / scale;
  const si = cx * n;
  const sj = cy * n;
  let worse = false;
  for (let j = sj; j < sj + n && !worse; j++) {
    for (let i = si; i < si + n && !worse; i++) {
      worse = (grid[j * SLOTS + i] as number) > own;
    }
  }
  if (!worse) {
    out.push(name, cx * size, cy * size, size);
    return;
  }
  const step = extent / SLOTS;
  for (let j = sj; j < sj + n; j++) {
    for (let i = si; i < si + n; i++) {
      const rank = Math.max(own, grid[j * SLOTS + i] as number);
      out.push(RANK_NAME[rank] as number, i * step, j * step, step);
    }
  }
}

/**
 * The rectangles sorted by class name, y0, y1 and x0, runs along a row
 * merged. With `units` every coordinate is a whole number of reach slots of
 * `step`, and the order is that of one number per rectangle.
 */
function mergedRects(r: RectColumns, step: number, units: boolean): UkcRect[] {
  const { cls, x0, y0, x1, y1 } = r;
  let order: ArrayLike<number>;
  if (units && r.n <= INDEX_SPAN) {
    const keys = r.key.subarray(0, r.n);
    for (let i = 0; i < r.n; i++) {
      const u =
        (((cls[i] as number) * 65 + (y0[i] as number) / step) * 65 + (y1[i] as number) / step) * 65;
      keys[i] = (u + (x0[i] as number) / step) * INDEX_SPAN + i;
    }
    keys.sort();
    order = keys.map((k) => k % INDEX_SPAN);
  } else {
    const index = r.order.subarray(0, r.n);
    index.forEach((_, i) => (index[i] = i));
    order = index.sort(
      (a, b) =>
        (cls[a] as number) - (cls[b] as number) ||
        (y0[a] as number) - (y0[b] as number) ||
        (y1[a] as number) - (y1[b] as number) ||
        (x0[a] as number) - (x0[b] as number)
    );
  }
  const merged: UkcRect[] = [];
  let last: UkcRect | undefined;
  let lastCls = -1;
  for (let k = 0; k < order.length; k++) {
    const i = order[k] as number;
    const c = cls[i] as number;
    if (last && lastCls === c && last.y0 === y0[i] && last.y1 === y1[i] && last.x1 === x0[i]) {
      last.x1 = x1[i] as number;
    } else {
      last = {
        class: BY_NAME[c] as UkcClass,
        x0: x0[i] as number,
        y0: y0[i] as number,
        x1: x1[i] as number,
        y1: y1[i] as number
      };
      lastCls = c;
      merged.push(last);
    }
  }
  return merged;
}

/**
 * Classed rectangles for tile (z, x, y), runs of equal class merged along
 * rows. With `cache` the tile's geometry is walked once and reused.
 */
export function ukcTile(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  extent: number,
  input: UkcTileInput,
  cache?: UkcTileCache
): UkcRect[] {
  return drawTile(geometryOf(store, z, x, y, cache), extent, input, undefined);
}

/** ukcTile and the thresholds over which it is drawn the same. */
export function ukcTileWithRange(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  extent: number,
  input: UkcTileInput,
  cache?: UkcTileCache
): { rects: UkcRect[]; range: ThresholdRange } {
  const range = { lo: -Infinity, hi: Infinity };
  return { rects: drawTile(geometryOf(store, z, x, y, cache), extent, input, range), range };
}

function geometryOf(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  cache: UkcTileCache | undefined
): TileGeometry {
  return cache ? cache.geometry(store, z, x, y) : tileGeometry(store, z, x, y);
}

function drawTile(
  g: TileGeometry,
  extent: number,
  input: UkcTileInput,
  range: ThresholdRange | undefined
): UkcRect[] {
  const kinds = g.dMin.length;
  const classes: (UkcClass | undefined)[] = [];
  const ranks = new Uint8Array(kinds);
  const v: NodeValues = { dMin: 0, sigmaD: 0, sigmaP: 0, flags: 0, cellRef: -1 };
  for (let k = 0; k < kinds; k++) {
    v.dMin = g.dMin[k] as number;
    v.sigmaD = g.sigmaD[k] as number;
    v.flags = g.flags[k] as number;
    const cls = classed(v, input, g.bound[k] === 1, range);
    classes.push(cls);
    ranks[k] = cls === undefined ? 0 : cls === "land" ? RANK.danger : RANK[cls];
  }
  const grid = reachGrid(g, ranks);
  // Slot rectangles partition the tile, so a cell split into them adds at most SLOTS² in all.
  scratch.reset(g.cellKind.length + SLOTS * SLOTS);
  for (let c = 0; c < g.cellKind.length; c++) {
    const cls = classes[g.cellKind[c] as number];
    if (cls !== undefined) {
      cellRects(scratch, g, c, cls, extent, grid);
    }
  }
  const step = extent / SLOTS;
  const units = extent % SLOTS === 0 && g.cellZ.every((dz) => dz <= DETAIL_ZOOMS);
  return mergedRects(scratch, step, units);
}
