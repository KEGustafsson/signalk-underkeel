import { probabilityBelowZero } from "../foundation/stats";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import type { Thresholds } from "./lookahead";
import type { UkcTileCache } from "./ukc-tile-cache";
import type { TileGeometry } from "./ukc-tile-geometry";
import { DETAIL_ZOOMS, SLOTS, tileGeometry, UNVERIFIED } from "./ukc-tile-geometry";
import type { ThresholdRange } from "./ukc-reach";
import { narrow, RANK, reachGrid, SLACK } from "./ukc-reach";

export { DETAIL_ZOOMS };
export type { ThresholdRange };

/**
 * UKC overlay (plan §4.10): every pyramid cell in a web-map tile classed by
 * P(UKC < 0) for the current draft and water level. A cell coarser than the
 * drawing resolution is classed by its bound (shallowest depth, widest σ),
 * which never shows a cell safer than any part of it. A slot also takes the
 * class a route check or `POST /query` there would give it from the cells
 * around it: each one's P weighted by the chance its chart position is off
 * by their distance (`chart-position.ts`), and the flags of an unverified
 * cell within its flag reach. A slot raised so above its own cell's class is
 * marked `reach`, for drawing it apart from what the chart says there.
 */

export type UkcClass = "clear" | "caution" | "danger" | "unverified" | "land";

export interface UkcRect {
  class: UkcClass;
  /** Tile extent units, y down. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Raised above its own cell's class by a nearby cell's chart position or flags. */
  reach?: true;
}

export interface UkcTileInput {
  threshold: number;
  sigmaExtra: number;
  thresholds: Thresholds;
  /** The water level is a fallback: nothing is drawn as clear. */
  degraded: boolean;
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

const BY_RANK = ["clear", "caution", "unverified", "danger"] as const;

type WaterClass = keyof typeof RANK;

/** Classes in the order the drawn rectangles are sorted by: their names' order. */
const BY_NAME: UkcClass[] = ["caution", "clear", "danger", "land", "unverified"];
const NAME_ORDER = new Map(BY_NAME.map((c, i) => [c, i]));
const RANK_NAME = BY_RANK.map((c) => NAME_ORDER.get(c) as number);

/**
 * Rectangles as columns, reused across tiles: `code` is twice the index in
 * BY_NAME, plus 1 for a rectangle raised by reach.
 */
class RectColumns {
  n = 0;
  code = new Uint8Array(0);
  x0 = new Float64Array(0);
  y0 = new Float64Array(0);
  x1 = new Float64Array(0);
  y1 = new Float64Array(0);
  order = new Uint32Array(0);
  key = new Float64Array(0);

  /** Empties the columns, with room for `cap` rectangles. */
  reset(cap: number): void {
    this.n = 0;
    if (this.code.length < cap) {
      Object.assign(this, {
        code: new Uint8Array(cap),
        x0: new Float64Array(cap),
        y0: new Float64Array(cap),
        x1: new Float64Array(cap),
        y1: new Float64Array(cap),
        order: new Uint32Array(cap),
        key: new Float64Array(cap)
      });
    }
  }

  push(cls: number, reach: boolean, x0: number, y0: number, size: number): void {
    const i = this.n++;
    this.code[i] = 2 * cls + (reach ? 1 : 0);
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
    out.push(name, false, cx * size, cy * size, size);
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
    out.push(name, false, cx * size, cy * size, size);
    return;
  }
  const step = extent / SLOTS;
  for (let j = sj; j < sj + n; j++) {
    for (let i = si; i < si + n; i++) {
      const reached = grid[j * SLOTS + i] as number;
      const raised = reached > own;
      out.push(RANK_NAME[raised ? reached : own] as number, raised, i * step, j * step, step);
    }
  }
}

/**
 * The rectangles sorted by class name and reach, y0, y1 and x0, runs along
 * a row merged. With `units` every coordinate is a whole number of reach
 * slots of `step`, and the order is that of one number per rectangle.
 */
function mergedRects(r: RectColumns, step: number, units: boolean): UkcRect[] {
  const { code, x0, y0, x1, y1 } = r;
  let order: ArrayLike<number>;
  if (units && r.n <= INDEX_SPAN) {
    const keys = r.key.subarray(0, r.n);
    for (let i = 0; i < r.n; i++) {
      const u =
        (((code[i] as number) * 65 + (y0[i] as number) / step) * 65 + (y1[i] as number) / step) *
        65;
      keys[i] = (u + (x0[i] as number) / step) * INDEX_SPAN + i;
    }
    keys.sort();
    order = keys.map((k) => k % INDEX_SPAN);
  } else {
    const index = r.order.subarray(0, r.n);
    index.forEach((_, i) => (index[i] = i));
    order = index.sort(
      (a, b) =>
        (code[a] as number) - (code[b] as number) ||
        (y0[a] as number) - (y0[b] as number) ||
        (y1[a] as number) - (y1[b] as number) ||
        (x0[a] as number) - (x0[b] as number)
    );
  }
  const merged: UkcRect[] = [];
  let last: UkcRect | undefined;
  let lastCode = -1;
  for (let k = 0; k < order.length; k++) {
    const i = order[k] as number;
    const c = code[i] as number;
    if (last && lastCode === c && last.y0 === y0[i] && last.y1 === y1[i] && last.x1 === x0[i]) {
      last.x1 = x1[i] as number;
    } else {
      last = {
        class: BY_NAME[c >> 1] as UkcClass,
        x0: x0[i] as number,
        y0: y0[i] as number,
        x1: x1[i] as number,
        y1: y1[i] as number
      };
      if (c & 1) {
        last.reach = true;
      }
      lastCode = c;
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
  const drawn = new Uint8Array(kinds);
  for (const k of g.cellKind) {
    drawn[k] = 1;
  }
  const classes: (UkcClass | undefined)[] = [];
  const v: NodeValues = { dMin: 0, sigmaD: 0, sigmaP: 0, flags: 0, cellRef: -1 };
  for (let k = 0; k < kinds; k++) {
    if (drawn[k] === 0) {
      classes.push(undefined);
      continue;
    }
    v.dMin = g.dMin[k] as number;
    v.sigmaD = g.sigmaD[k] as number;
    v.flags = g.flags[k] as number;
    classes.push(classed(v, input, g.bound[k] === 1, range));
  }
  const grid = reachGrid(g, input, range);
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
