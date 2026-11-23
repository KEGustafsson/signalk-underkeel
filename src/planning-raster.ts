import type { RouteCheckInput } from "./engine/route-check";
import { footprintStatus } from "./engine/route-check";
import { QUERY_WORK } from "./engine/work";
import type { LonLat, Rect } from "./foundation/geo";
import { fromMercator, tileRect, tileSize } from "./foundation/geo";
import { geomBounds } from "./foundation/geometry";
import { probabilityBelowZero } from "./foundation/stats";
import { PREFERENCE_CLASSES } from "./ingest/rule-features";
import { sigmaExtra, thresholdDepth } from "./model/uncertainty";
import { vesselTerms } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";
import { chartReach, chartSigma } from "./spatial/chart-position";
import type { NodeStore } from "./spatial/node-store";
import { FLAGS, flagNames, NO_DATA } from "./spatial/node-store";

/**
 * A planning session's raster (planning API feature "raster"): the status every cell of a block
 * of the index's finest tiles has for the session's vessel, speed and window, read in one walk
 * of the pyramid. A cell is a tile at the pyramid's deepest zoom, the one a swept area's edge
 * is split to (`NodeStore.leafZoom`), so no tile is finer than a cell. A planner tests a leg against the cells near it instead of asking for the leg's
 * corridor: where every cell within the corridor and the chart's reach passes, the leg passes;
 * where a cell that no water level opens lies in the corridor, it does not; any other leg it
 * asks `segment` about. A cell is scored as `checkFootprint` scores a footprint that is the
 * cell alone, at the lowest water of the session's window over the block, so a cell that
 * passes here passes in any corridor's verdict over any part of the window.
 */

/** A cell's status, bits 0–1 of its byte, in the order of `RASTER_STATUS`. */
export const RASTER_STATUS = ["ok", "marginal", "fail", "unverified"] as const;

export const RASTER = {
  /** Bits 0–1: the index into `RASTER_STATUS`. */
  STATUS: 3,
  /** P(UKC < 0) at or above the session's accepted probability. */
  RISKY: 4,
  /**
   * No water level in the window brings the cell's P under the accepted probability: land, no
   * charted depth, or a depth whose P at the window's highest water, with no σ for the level,
   * is still at or above it.
   */
  STUCK: 8,
  /**
   * The cell's tile is split finer than the raster: its status and risk are those of its parts
   * together, never better than any one of them. No index built at the raster's zoom has such
   * a tile; the bit keeps a split tile from ever being read as one value.
   */
  MIXED: 64,
  /**
   * Nothing here answers for a leg: a rule object (a bridge, a restricted area, a traffic
   * lane, a fairway gap strip), a living-chart sounding, a block of the index not loaded, or a
   * fallback water level. A leg reaching the cell is asked of `segment`.
   */
  ASK: 128
} as const;

export interface Raster {
  /** The cells' Web Mercator zoom: the pyramid's deepest. */
  z: number;
  /** Tile column and row of the north-west cell. */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** One byte a cell (`RASTER`), row by row from the north-west. */
  cells: Uint8Array;
  /** Per cell, the index in `flagSets` of its verdict's flags. */
  flags: Uint8Array;
  flagSets: string[][];
  /**
   * How far past a corridor a tile still counts in its verdict, ground metres: the chart
   * position reach of the index's widest σ (`spatial/chart-position.ts`).
   */
  reach: number;
  /** Work the walk did (`engine/work.ts`). */
  work: number;
}

/** A block holds at most this many cells: its walk runs without a pause. */
export const MAX_RASTER_CELLS = 2 ** 20;

/** The most flag sets a block names; a block with more answers ASK where the others lie. */
const MAX_FLAG_SETS = 255;

interface Scored {
  byte: number;
  flags: number;
}

/**
 * What every cell of a block is scored with: the UKC-zero depth and σ at the window's lowest
 * water over the block, the UKC-zero depth at its highest, and the accepted probability.
 */
interface Scoring {
  threshold: number;
  sigmaExtra: number;
  /** The UKC-zero depth at the highest water; -Infinity when that level is not known. */
  thresholdHigh: number;
  /** σ of the draft and waves alone: the least `sigmaExtra` any water level leaves. */
  sigmaLeast: number;
  probability: number;
}

/** A risk as a verdict states it, to four decimals. */
const stated = (risk: number): number => Math.round(risk * 10000) / 10000;

/**
 * The least P(UKC < 0) a depth has at any time in the window: over a part of the window the
 * level is no higher than the window's highest and its σ no less than none. With the mean UKC
 * at or under zero P is at least 0.5 whatever σ; over zero it falls with the level and with σ.
 */
function leastRisk(dMin: number, sigmaD: number, s: Scoring): number {
  const mean = dMin - s.thresholdHigh;
  return mean <= 0 ? 0.5 : probabilityBelowZero(mean, Math.hypot(sigmaD, s.sigmaLeast));
}

const ring = (r: Rect): LonLat[] => [
  fromMercator(r.minX, r.minY),
  fromMercator(r.maxX, r.minY),
  fromMercator(r.maxX, r.maxY),
  fromMercator(r.minX, r.maxY)
];

/** Flags as the raster holds them: a node's own, and LAND above them. */
const LAND = 1 << 15;

function namesOf(bits: number): string[] {
  const names = flagNames(bits & ~LAND);
  if (bits & LAND) {
    names.push("LAND");
  }
  return names;
}

/** One cell's byte and flags from a node's values; `mixed` for a node split under the cell. */
function score(dMin: number, sigmaD: number, flags: number, s: Scoring, mixed: boolean): Scored {
  const noDepth = (flags & FLAGS.NO_DEPTH) !== 0;
  const land = !noDepth && dMin === -Infinity;
  // As `checkFootprint`: a tile with no depth sets no risk and no charted depth.
  const risk = noDepth
    ? 0
    : probabilityBelowZero(dMin - s.threshold, Math.hypot(sigmaD, s.sigmaExtra));
  const charted = noDepth || land ? null : dMin;
  const status = footprintStatus(risk, charted, flags, land, s.probability);
  // Neither `ok` (P under the probability) nor an unverified verdict a planner accepts (its
  // stated P under it) is to be had at any water level in the window.
  const least = land || noDepth ? 1 : leastRisk(dMin, sigmaD, s);
  const stuck = land || noDepth || Math.min(least, stated(least)) >= s.probability;
  return {
    byte:
      RASTER_STATUS.indexOf(status) |
      // As a verdict states its risk: a planner holds it to its probability.
      (stated(risk) >= s.probability ? RASTER.RISKY : 0) |
      (stuck ? RASTER.STUCK : 0) |
      (mixed ? RASTER.MIXED : 0) |
      // Parts with no depth say nothing of the depth of the others.
      (mixed && noDepth ? RASTER.ASK : 0),
    flags: (flags & ~FLAGS.NO_DEPTH) | (land ? LAND : 0)
  };
}

/** A node's values scored: a cell's byte and the index of its flag set. */
interface Painted {
  dMin: number;
  sigmaD: number;
  flags: number;
  split: boolean;
  byte: number;
  set: number;
}

interface Painter {
  store: NodeStore;
  s: Scoring;
  out: Raster;
  /** Flag bits to the index of their set in `out.flagSets`. */
  sets: Map<number, number>;
  /**
   * Scores by node values, which repeat: a depth area is thousands of tiles of one value, so
   * the last one scored is tried first, then the others by their flags.
   */
  last: Painted | undefined;
  memo: Map<number, Painted[]>;
  visits: number;
}

function setOf(p: Painter, bits: number): number {
  let i = p.sets.get(bits);
  if (i === undefined) {
    i = p.out.flagSets.length < MAX_FLAG_SETS ? p.out.flagSets.push(namesOf(bits)) - 1 : -1;
    p.sets.set(bits, i);
  }
  return i;
}

/** Writes one value over the cells [cx0, cx1) × [cy0, cy1) of the block. */
function fill(
  p: Painter,
  [cx0, cy0, cx1, cy1]: readonly [number, number, number, number],
  byte: number,
  set: number
): void {
  const { cells, flags, cols } = p.out;
  // Most tiles are one cell, or a few: written one by one, a call to fill costs more.
  const narrow = cx1 - cx0 < 16;
  for (let y = cy0; y < cy1; y++) {
    const from = y * cols + cx0;
    const to = y * cols + cx1;
    if (narrow) {
      for (let k = from; k < to; k++) {
        cells[k] = byte;
        flags[k] = set;
      }
    } else {
      cells.fill(byte, from, to);
      flags.fill(set, from, to);
    }
  }
}

/** Tile (z, x, y) painted over the cells of the block it holds. */
function paint(p: Painter, z: number, x: number, y: number): void {
  const { out, store } = p;
  const shift = out.z - z;
  const scale = 2 ** shift;
  const cx0 = Math.max(0, x * scale - out.x0);
  const cy0 = Math.max(0, y * scale - out.y0);
  const cx1 = Math.min(out.cols, (x + 1) * scale - out.x0);
  const cy1 = Math.min(out.rows, (y + 1) * scale - out.y0);
  if (cx0 >= cx1 || cy0 >= cy1) {
    return;
  }
  p.visits++;
  const i = store.find(z, x, y);
  const split = i >= 0 && store.isSplit(i);
  if (split && z < out.z) {
    if (store.standIn(i, z, x, y)) {
      // Its block is not loaded: a query reads a stand-in until it is, then the tiles.
      const set = Math.max(0, setOf(p, FLAGS.NO_COVERAGE));
      fill(p, [cx0, cy0, cx1, cy1], RASTER.ASK | RASTER_STATUS.indexOf("unverified"), set);
      return;
    }
    paint(p, z + 1, 2 * x, 2 * y);
    paint(p, z + 1, 2 * x + 1, 2 * y);
    paint(p, z + 1, 2 * x, 2 * y + 1);
    paint(p, z + 1, 2 * x + 1, 2 * y + 1);
    return;
  }
  const v = i < 0 ? NO_DATA : store.values(i);
  const m = painted(p, v.dMin, v.sigmaD, v.flags, split);
  fill(p, [cx0, cy0, cx1, cy1], m.byte, m.set);
}

function painted(p: Painter, dMin: number, sigmaD: number, flags: number, split: boolean): Painted {
  const same = (m: Painted): boolean =>
    m.dMin === dMin && m.sigmaD === sigmaD && m.flags === flags && m.split === split;
  if (p.last && same(p.last)) {
    return p.last;
  }
  let list = p.memo.get(flags);
  if (!list) {
    list = [];
    p.memo.set(flags, list);
  }
  let m = list.find(same);
  if (!m) {
    const scored = score(dMin, sigmaD, flags, p.s, split);
    const set = setOf(p, scored.flags);
    const byte = set < 0 ? scored.byte | RASTER.ASK : scored.byte;
    m = { dMin, sigmaD, flags, split, byte, set: Math.max(0, set) };
    list.push(m);
  }
  p.last = m;
  return m;
}

/** Marks the cells the Mercator rectangle `r` meets as ASK. */
function ask(out: Raster, r: Rect): void {
  const size = tileSize(out.z);
  const origin = tileRect(out.z, out.x0, out.y0);
  const cx0 = Math.max(0, Math.floor((r.minX - origin.minX) / size));
  const cx1 = Math.min(out.cols - 1, Math.floor((r.maxX - origin.minX) / size));
  const cy0 = Math.max(0, Math.floor((origin.maxY - r.maxY) / size));
  const cy1 = Math.min(out.rows - 1, Math.floor((origin.maxY - r.minY) / size));
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      out.cells[y * out.cols + x] = (out.cells[y * out.cols + x] as number) | RASTER.ASK;
    }
  }
}

const PREFERENCES: ReadonlySet<string> = new Set(PREFERENCE_CLASSES);

/**
 * The raster of the block of `cols` × `rows` cells whose north-west cell is tile
 * (x0, y0), for a session's `input` over `window`. Throws RangeError for a block that is empty,
 * over MAX_RASTER_CELLS or off the tile grid.
 */
export function sessionRaster(
  index: ChartIndex,
  input: RouteCheckInput,
  window: { start: number; end: number },
  block: { x0: number; y0: number; cols: number; rows: number }
): Raster {
  const store = index.pyramid;
  const { x0, y0, cols, rows } = block;
  const whole = [x0, y0, cols, rows].every((v) => Number.isInteger(v));
  if (!whole || cols < 1 || rows < 1 || cols * rows > MAX_RASTER_CELLS) {
    throw new RangeError(`raster block must be 1..${MAX_RASTER_CELLS} whole cells`);
  }
  const z = store.leafZoom;
  if (x0 < 0 || y0 < 0 || x0 + cols > 2 ** z || y0 + rows > 2 ** z) {
    throw new RangeError(`raster block lies off the zoom ${z} tile grid`);
  }
  const nw = tileRect(z, x0, y0);
  const se = tileRect(z, x0 + cols - 1, y0 + rows - 1);
  const bounds: Rect = { minX: nw.minX, minY: se.minY, maxX: se.maxX, maxY: nw.maxY };
  const at = ring(bounds);
  const wl = input.waterLevel(window.start, window.end, at, true);
  const high = input.highWater?.(window.start, window.end, at, true);
  const terms = vesselTerms(input.vessel, { waveHeight: input.waveHeight }, input.dynamics);
  const s: Scoring = {
    threshold: thresholdDepth(terms, wl),
    sigmaExtra: sigmaExtra(terms, wl),
    thresholdHigh: high && high.degraded === undefined ? thresholdDepth(terms, high) : -Infinity,
    sigmaLeast: Math.hypot(terms.draft.sigma, terms.wave.sigma),
    probability: input.probability
  };
  // A plan's sessions differ in their corridor alone, which a raster does not read: the block
  // painted for one serves the next, while the index and the scoring stay as they were.
  const key = [
    x0,
    y0,
    cols,
    rows,
    s.threshold,
    s.sigmaExtra,
    s.thresholdHigh,
    s.sigmaLeast,
    s.probability,
    wl.degraded === undefined ? 0 : 1,
    store.adjustments.revision,
    store.loadRevision
  ].join("|");
  const held = keptFor(index);
  const hit = held.get(key);
  if (hit) {
    // Read again last, so the blocks least lately read go first.
    held.delete(key);
    held.set(key, hit);
    return { ...hit, work: QUERY_WORK };
  }
  const out = paintRaster(index, s, { ...block, z, bounds }, wl.degraded !== undefined);
  held.set(key, out);
  if (held.size > KEPT_BLOCKS) {
    held.delete(held.keys().next().value as string);
  }
  return out;
}

/** Rasters kept per index, least lately read first; a planner must not write to their arrays. */
const kept = new WeakMap<ChartIndex, Map<string, Raster>>();

/** Blocks kept per index: about 130 kB each at 256 cells a side. */
const KEPT_BLOCKS = 160;

function keptFor(index: ChartIndex): Map<string, Raster> {
  let held = kept.get(index);
  if (!held) {
    held = new Map();
    kept.set(index, held);
  }
  return held;
}

function paintRaster(
  index: ChartIndex,
  s: Scoring,
  block: { x0: number; y0: number; cols: number; rows: number; z: number; bounds: Rect },
  degraded: boolean
): Raster {
  const store = index.pyramid;
  const { x0, y0, cols, rows, z, bounds } = block;
  const graded = chartSigma(store).max;
  const out: Raster = {
    z,
    x0,
    y0,
    cols,
    rows,
    cells: new Uint8Array(cols * rows),
    flags: new Uint8Array(cols * rows),
    flagSets: [],
    reach: chartReach(graded),
    work: 0
  };
  const p: Painter = {
    store,
    s,
    out,
    sets: new Map(),
    last: undefined,
    memo: new Map(),
    visits: 0
  };
  const shift = 2 ** (z - store.minZoom);
  for (let x = Math.floor(x0 / shift); x <= Math.floor((x0 + cols - 1) / shift); x++) {
    for (let y = Math.floor(y0 / shift); y <= Math.floor((y0 + rows - 1) / shift); y++) {
      paint(p, store.minZoom, x, y);
    }
  }
  out.work = p.visits + QUERY_WORK;
  if (degraded) {
    // A fallback level is a guess: every leg here is the exact check's (invariant 3).
    for (let k = 0; k < out.cells.length; k++) {
      out.cells[k] = (out.cells[k] as number) | RASTER.ASK;
    }
    return out;
  }
  // What a verdict reads besides the tiles: the rule objects, and the living chart's soundings.
  for (const f of index.rules.size === 0 ? [] : index.rules.near(bounds)) {
    if (!PREFERENCES.has(f.objectClass)) {
      ask(out, geomBounds(f.geom));
    }
  }
  if (store.adjustments.size > 0) {
    const az = store.adjustZoom;
    const n = 2 ** az;
    for (const key of store.adjustments.keys()) {
      const r = tileRect(az, Math.floor(key / n), key % n);
      const meets =
        r.maxX >= bounds.minX &&
        r.minX <= bounds.maxX &&
        r.maxY >= bounds.minY &&
        r.minY <= bounds.maxY;
      if (meets) {
        ask(out, r);
      }
    }
  }
  return out;
}
