import { normalCdf, probabilityBelowZero } from "../foundation/stats";
import { chartReach, chartWeight } from "../spatial/chart-position";
import type { Thresholds } from "./lookahead";
import type { TileGeometry } from "./ukc-tile-geometry";
import { MASK_WORDS, SLOTS } from "./ukc-tile-geometry";

/**
 * The reach grid of a UKC tile (plan §4.10): the worst class each slot takes
 * from the cells around it, as a route check or `POST /query` there would
 * count them (`chart-position.ts`), and the thresholds over which it holds.
 */

export interface ReachInput {
  threshold: number;
  sigmaExtra: number;
  thresholds: Thresholds;
}

/**
 * Thresholds, metres, at all of which a tile is drawn the same, both ends
 * included; the other inputs held. A tile drawn at a threshold inside the
 * range is byte for byte the tile drawn at any other inside it.
 */
export interface ThresholdRange {
  lo: number;
  hi: number;
}

/** Severity of a class reaching a cell, as the look-ahead and query order them. */
export const RANK = { clear: 0, caution: 1, unverified: 2, danger: 3 } as const;

/** Metres kept clear of a threshold where P crosses a level: far beyond its rounding error. */
export const SLACK = 1e-6;

interface Bracket {
  lo: number;
  hi: number;
}

/**
 * Where normalCdf crosses p: lo below it, hi at or past it, within 1e-9.
 * Searched on normalCdf itself rather than an inverse: normalCdf is good to
 * 1.5e-7, which in the tails moves a crossing by more than SLACK, so a range
 * must be found on the P it bounds.
 */
function bracket(p: number): Bracket {
  let lo = -40;
  let hi = 40;
  while (hi - lo > 1e-9) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) >= p) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return { lo, hi };
}

const CROSSINGS = new Map<number, Bracket>();

/** `bracket` of a configured level, kept: the levels are few. */
function crossing(p: number): Bracket {
  let x = CROSSINGS.get(p);
  if (x === undefined) {
    x = bracket(p);
    CROSSINGS.set(p, x);
  }
  return x;
}

/**
 * Narrows `range` to the side of level `p` that threshold `t` is on. The
 * crossing is dMin + x·σ; with σ 0, P steps from 0 to 1 at dMin. A side
 * reaches at least to `t`, since P is monotonic in the threshold.
 */
export function narrow(
  range: ThresholdRange,
  dMin: number,
  sigma: number,
  t: number,
  risk: number,
  p: number,
  x = crossing(p)
): void {
  // Past the crossing's upper end P ≥ p holds, short of its lower end P < p.
  const at = dMin + (sigma > 0 ? (risk >= p ? x.hi : x.lo) * sigma : 0);
  if (risk >= p) {
    range.lo = Math.max(range.lo, Math.min(t, at + SLACK));
  } else {
    range.hi = Math.min(range.hi, Math.max(t, at - SLACK));
  }
}

/**
 * P(UKC < 0) of a source kind as a footprint reaching it counts it: 1 for
 * land and for a bound at or above the threshold (some cell under it is at
 * P ≥ 0.5 there, and its narrowest σ may give 1), else from its values.
 */
function sourceRisk(g: TileGeometry, k: number, input: ReachInput): number {
  const dMin = g.dMin[k] as number;
  if (dMin === -Infinity || (g.bound[k] === 1 && dMin <= input.threshold)) {
    return 1;
  }
  const sigma = Math.hypot(g.sigmaD[k] as number, input.sigmaExtra);
  return probabilityBelowZero(dMin - input.threshold, sigma);
}

/**
 * Narrows `range` so a source kind's P stays in [lo, hi): within it every
 * slot its sources raise stays raised and every other stays as it is.
 */
function narrowSource(
  range: ThresholdRange,
  g: TileGeometry,
  k: number,
  input: ReachInput,
  bounds: { risk: number; lo: number; hi: number }
): void {
  const dMin = g.dMin[k] as number;
  if (dMin === -Infinity) {
    return;
  }
  const t = input.threshold;
  if (g.bound[k] === 1) {
    if (dMin <= t) {
      // P is 1 from dMin up.
      range.lo = Math.max(range.lo, dMin);
      return;
    }
    // P jumps to 1 at dMin.
    if (bounds.hi <= 1) {
      range.hi = Math.min(range.hi, Math.max(t, dMin - SLACK));
    }
  }
  const sigma = Math.hypot(g.sigmaD[k] as number, input.sigmaExtra);
  if (bounds.lo > 0) {
    narrow(range, dMin, sigma, t, bounds.risk, bounds.lo, bracket(bounds.lo));
  }
  if (bounds.hi <= 1) {
    narrow(range, dMin, sigma, t, bounds.risk, bounds.hi, bracket(bounds.hi));
  }
}

/**
 * Where P·Φ(−gap/σ) ≥ level stops holding, for P = risk ≥ level: `lo` the
 * widest gap where it holds and `hi` the narrowest where it does not, found
 * on the test itself to 1e-9 m. Φ is 1 within the buffer (gap 0), so a
 * touching slot is raised whenever P is.
 */
interface Crossing {
  lo: number;
  hi: number;
  exact: (gap: number) => boolean;
}

function crossingGap(risk: number, level: number, sigma: number): Crossing {
  const exact = (g: number): boolean => risk * chartWeight(g, sigma) >= level;
  let lo = 0;
  let hi = chartReach(sigma);
  if (exact(hi)) {
    return { lo, hi: Infinity, exact };
  }
  while (hi - lo > 1e-9) {
    const mid = (lo + hi) / 2;
    if (exact(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { lo, hi, exact };
}

const clampSlot = (v: number): number => Math.max(0, Math.min(SLOTS - 1, v));

/** The slot index along one axis nearest span [a, b]: within it, or at the tile edge facing it. */
const nearestSlot = (a: number, b: number): number =>
  b <= 0 ? 0 : a >= SLOTS ? SLOTS - 1 : clampSlot(Math.floor(Math.max(a, 0)));

/** Source s of a tile: its rectangle in slots and its gaps to slots in ground metres. */
class Source {
  readonly sigma: number;
  /** Slots per ground metre: the same for every source of a tile. */
  readonly scale: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** The column nearest it, where each row's least gap lies. */
  readonly iNear: number;

  constructor(g: TileGeometry, s: number) {
    this.sigma = g.sourceSigma[s] as number;
    this.scale = g.sourceScale[s] as number;
    this.x0 = g.sourceRect[4 * s] as number;
    this.y0 = g.sourceRect[4 * s + 1] as number;
    this.x1 = g.sourceRect[4 * s + 2] as number;
    this.y1 = g.sourceRect[4 * s + 3] as number;
    this.iNear = nearestSlot(this.x0, this.x1);
  }

  /** The squared gap to slot (i, j), in slots. */
  gap2(i: number, j: number): number {
    const gx = Math.max(0, this.x0 - (i + 1), i - this.x1);
    const gy = Math.max(0, this.y0 - (j + 1), j - this.y1);
    return gx * gx + gy * gy;
  }

  rowMin2(j: number): number {
    return this.gap2(this.iNear, j);
  }

  /** The least squared gap of any slot of the tile. */
  tileMin2(): number {
    return this.rowMin2(nearestSlot(this.y0, this.y1));
  }

  /**
   * The crossing's test on slot (i, j): a slot outside its bracket compares
   * its squared offset, one within it evaluates Φ, so the answer is the test's.
   */
  raiser(c: Crossing): (i: number, j: number) => boolean {
    const inside = (c.lo * this.scale) ** 2 * (1 - 1e-12);
    const outside = (c.hi * this.scale) ** 2 * (1 + 1e-12);
    return (i, j) => {
      const gx = Math.max(0, this.x0 - (i + 1), i - this.x1);
      const gy = Math.max(0, this.y0 - (j + 1), j - this.y1);
      const d2 = gx * gx + gy * gy;
      if (d2 <= inside) {
        return true;
      }
      return d2 < outside && c.exact(Math.hypot(gx, gy) / this.scale);
    };
  }

  /** Slots past its edges that a crossing may raise, with one to spare. */
  reach(c: Crossing): number {
    return Math.min(c.hi, chartReach(this.sigma)) * this.scale + 1;
  }
}

/** The widest gap raised (−1 for none) and the narrowest left, squared, in slots. */
interface Gaps {
  in2: number;
  out2: number;
}

/**
 * The run of row j where `test` holds, or undefined. The run holds the row's
 * nearest column whenever it is not empty; its ends are placed from `reach`
 * (slots, from the source's edges) and settled by `test` itself, so the run
 * is exactly where it holds. Updates `gaps` for the range.
 */
function rowRun(
  src: Source,
  j: number,
  reach: number,
  test: (i: number, j: number) => boolean,
  gaps: Gaps
): [number, number] | undefined {
  const mid = src.iNear;
  if (!test(mid, j)) {
    gaps.out2 = Math.min(gaps.out2, src.rowMin2(j));
    return undefined;
  }
  const gy = Math.max(0, src.y0 - (j + 1), j - src.y1);
  const w = Math.sqrt(Math.max(0, reach * reach - gy * gy));
  let a = Math.max(0, Math.min(mid, Math.ceil(src.x0 - 1 - w)));
  while (a > 0 && test(a - 1, j)) {
    a--;
  }
  while (a < mid && !test(a, j)) {
    a++;
  }
  let b = Math.min(SLOTS - 1, Math.max(mid, Math.floor(src.x1 + w)));
  while (b < SLOTS - 1 && test(b + 1, j)) {
    b++;
  }
  while (b > mid && !test(b, j)) {
    b--;
  }
  gaps.in2 = Math.max(gaps.in2, src.gap2(a, j), src.gap2(b, j));
  if (a > 0) {
    gaps.out2 = Math.min(gaps.out2, src.gap2(a - 1, j));
  }
  if (b < SLOTS - 1) {
    gaps.out2 = Math.min(gaps.out2, src.gap2(b + 1, j));
  }
  return [a, b];
}

/** Row width of a run cover: a difference array per row, one past the last slot. */
const COVER_ROW = SLOTS + 1;

/**
 * Marks in `cover`, a difference array per row, the run of slots where
 * P · Φ(−gap/σ) ≥ level for a source, by its crossing (undefined when P is
 * short of the level). Along a row the gap is the larger of a rising and a
 * falling term, so the raised slots are one run and the nearest slots left
 * are its neighbours; rows past the scanned ones lie further than their
 * neighbours. Updates `gaps` for the range.
 */
function raise(cover: Int32Array, src: Source, c: Crossing | undefined, gaps: Gaps): void {
  const tile2 = src.tileMin2();
  const tileGap = Math.sqrt(tile2) / src.scale;
  if (!c || tileGap >= c.hi || (tileGap > c.lo && !c.exact(tileGap))) {
    gaps.out2 = Math.min(gaps.out2, tile2);
    return;
  }
  const reach = src.reach(c);
  const j0 = clampSlot(Math.floor(src.y0 - reach));
  const j1 = clampSlot(Math.ceil(src.y1 + reach));
  const test = src.raiser(c);
  // The test reads a row only through its vertical gap: the rows within the
  // source's own span (gap 0) share their run and their gaps.
  let span: [number, number] | undefined | null = null;
  for (let j = j0; j <= j1; j++) {
    const inSpan = j >= src.y0 - 1 && j <= src.y1;
    let run: [number, number] | undefined;
    if (inSpan && span !== null) {
      run = span;
    } else {
      run = rowRun(src, j, reach, test, gaps);
      if (inSpan) {
        span = run;
      }
    }
    if (run) {
      cover[j * COVER_ROW + run[0]] = (cover[j * COVER_ROW + run[0]] as number) + 1;
      cover[j * COVER_ROW + run[1] + 1] = (cover[j * COVER_ROW + run[1] + 1] as number) - 1;
    }
  }
  if (j0 > 0) {
    gaps.out2 = Math.min(gaps.out2, src.rowMin2(j0 - 1));
  }
  if (j1 < SLOTS - 1) {
    gaps.out2 = Math.min(gaps.out2, src.rowMin2(j1 + 1));
  }
}

/** Raises to `rank` every slot some run of `cover` holds. */
function fill(grid: Uint8Array, cover: Int32Array, rank: number): void {
  for (let j = 0; j < SLOTS; j++) {
    let held = 0;
    for (let i = 0; i < SLOTS; i++) {
      held += cover[j * COVER_ROW + i] as number;
      const k = j * SLOTS + i;
      if (held > 0 && (grid[k] as number) < rank) {
        grid[k] = rank;
      }
    }
  }
}

/** Raises the slots within an unverified kind's flag reach to unverified. */
function raiseFlags(grid: Uint8Array, g: TileGeometry): void {
  for (let m = 0; m < g.flagKind.length; m++) {
    for (let w = 0; w < MASK_WORDS; w++) {
      let bits = (g.flagMask[m * MASK_WORDS + w] as number) | 0;
      while (bits !== 0) {
        const low = bits & -bits;
        const k = w * 32 + 31 - Math.clz32(low);
        if ((grid[k] as number) < RANK.unverified) {
          grid[k] = RANK.unverified;
        }
        bits ^= low;
      }
    }
  }
}

/**
 * The sources of one kind and σ at one level: they share a P and so a
 * crossing, found once per drawing, and the gaps they raised and left.
 */
interface Group {
  k: number;
  sigma: number;
  scale: number;
  level: number;
  crossing: Crossing | undefined;
  gaps: Gaps;
}

/**
 * The worst rank reaching each slot: danger or caution where a source's
 * weighted P reaches the level, unverified within an unverified kind's flag
 * reach. With `range`, narrowed so every slot keeps its rank.
 */
export function reachGrid(
  g: TileGeometry,
  input: ReachInput,
  range: ThresholdRange | undefined
): Uint8Array | undefined {
  if (g.sourceKind.length === 0 && g.flagKind.length === 0) {
    return undefined;
  }
  const grid = new Uint8Array(SLOTS * SLOTS);
  raiseFlags(grid, g);
  const risks = new Map<number, number>();
  // By kind, then σ: one group per level.
  const groups = new Map<number, Map<number, Group[]>>();
  const levels = [
    [input.thresholds.warn, RANK.danger],
    [input.thresholds.alert, RANK.caution]
  ] as const;
  const covers = levels.map(() => new Int32Array(SLOTS * COVER_ROW));
  for (let s = 0; s < g.sourceKind.length; s++) {
    const k = g.sourceKind[s] as number;
    let risk = risks.get(k);
    if (risk === undefined) {
      risk = sourceRisk(g, k, input);
      risks.set(k, risk);
    }
    const src = new Source(g, s);
    let bySigma = groups.get(k);
    if (!bySigma) {
      bySigma = new Map();
      groups.set(k, bySigma);
    }
    let pair = bySigma.get(src.sigma);
    if (!pair) {
      const p = risk;
      pair = levels.map(([level]) => ({
        k,
        sigma: src.sigma,
        scale: src.scale,
        level,
        crossing: p >= level ? crossingGap(p, level, src.sigma) : undefined,
        gaps: { in2: -1, out2: Infinity }
      }));
      bySigma.set(src.sigma, pair);
    }
    levels.forEach((_, n) => {
      const group = (pair as Group[])[n] as Group;
      raise(covers[n] as Int32Array, src, group.crossing, group.gaps);
    });
  }
  levels.forEach(([, rank], n) => fill(grid, covers[n] as Int32Array, rank));
  if (range) {
    narrowGroups(range, g, input, risks, groups);
  }
  return grid;
}

/**
 * Narrows `range` so each source kind's P stays where each of its groups
 * keeps its widest raised gap raised and its narrowest left gap left.
 */
function narrowGroups(
  range: ThresholdRange,
  g: TileGeometry,
  input: ReachInput,
  risks: ReadonlyMap<number, number>,
  groups: ReadonlyMap<number, ReadonlyMap<number, Group[]>>
): void {
  const bounds = new Map<number, { risk: number; lo: number; hi: number }>();
  const all = [...groups.values()].flatMap((bySigma) => [...bySigma.values()].flat());
  for (const { k, sigma, scale, level, gaps } of all) {
    let b = bounds.get(k);
    if (!b) {
      b = { risk: risks.get(k) as number, lo: 0, hi: Infinity };
      bounds.set(k, b);
    }
    if (gaps.in2 >= 0) {
      b.lo = Math.max(b.lo, level / chartWeight(Math.sqrt(gaps.in2) / scale, sigma));
    }
    if (gaps.out2 !== Infinity) {
      b.hi = Math.min(b.hi, level / chartWeight(Math.sqrt(gaps.out2) / scale, sigma));
    }
  }
  for (const [k, b] of bounds) {
    narrowSource(range, g, k, input, b);
  }
}
