import type { LonLat, Rect, XY } from "../foundation/geo";
import {
  fromMercator,
  haversine,
  tileRange,
  tileRect,
  tileSize,
  toMercator
} from "../foundation/geo";
import { segmentRectSpan } from "../foundation/geometry";
import type { NodeStore } from "./node-store";
import { FLAGS } from "./node-store";

/**
 * Land under a leg's own line, apart from its corridor. A corridor reaching land fails the leg
 * and flags it LAND, which a boat alongside a quay cannot avoid: a planner lets a short leg
 * from a berth carry it. That leg must still not go through a breakwater to the water behind,
 * so the route check tells the two apart (`crossesLand`).
 */

/** A stretch of the line over one land tile: fractions along the leg, and the tile's width. */
interface Stretch {
  from: number;
  to: number;
  /** Ground metres across the tile. */
  width: number;
}

/** The tiles a land walk visited, counted into its leg's work (`work.ts`). */
export interface Walked {
  visits: number;
}

/** Stretches closer than this, as a fraction of the leg, run on from one another. */
const JOIN = 1e-9;
/** Land at a leg's end is its own as far as this many widths of the tile it lies in, at least. */
const END_TILES = 2;
/** A land tile counts as at most this wide, metres. */
const MAX_END_TILE = 20;
/**
 * Land at a leg's end is its own as far as this many times the way from the end to the nearest
 * water, and one tile more: a point put on land leaves it about the nearest way. A boat
 * alongside a breakwater has water a few metres away, so the land beyond is crossed.
 */
const NEAREST_WATER_SLACK = 1.5;
/** How far from a leg's end water is looked for, metres: past it the end's own land ends there. */
const WATER_SEARCH = 500;

/**
 * The land tiles the straight line a→b on the chart passes over, as stretches of it, in
 * order. Land is a tile with a depth of −∞ that is charted: one with no chart is not land. A
 * tile whose block is not loaded and holds land counts as land all over, of no width: the line
 * crosses it wherever it lies, so a leg is never cleared on a block still to come.
 */
function landUnder(store: NodeStore, a: XY, b: XY, cos: number, walked: Walked): Stretch[] {
  const out: Stretch[] = [];
  const visit = (z: number, x: number, y: number): void => {
    walked.visits++;
    const span = segmentRectSpan(a, b, tileRect(z, x, y));
    const i = span ? store.find(z, x, y) : -1;
    if (!span || i < 0) {
      return;
    }
    const v = store.values(i);
    // A parent holds the shallowest of its children: none of them is land under a depth.
    if (v.dMin !== -Infinity) {
      return;
    }
    const whole = { from: span[0], to: span[1], width: tileSize(z) * cos };
    if (!store.isSplit(i)) {
      if ((v.flags & FLAGS.NO_DEPTH) === 0) {
        out.push(whole);
      }
      return;
    }
    const unloaded = store.standIn(i, z, x, y);
    if (unloaded) {
      if (unloaded.covered === -Infinity) {
        // Where under the tile the land lies is not known: no width makes it land at an end.
        out.push({ ...whole, width: 0 });
      }
      return;
    }
    for (const [dx, dy] of CHILDREN) {
      visit(z + 1, 2 * x + dx, 2 * y + dy);
    }
  };
  const bounds: Rect = {
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1])
  };
  const range = tileRange(store.minZoom, bounds);
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      visit(store.minZoom, x, y);
    }
  }
  return out.sort((p, q) => p.from - q.from || p.to - q.to);
}

const CHILDREN = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1]
] as const;

/** Mercator distance from `p` to rectangle `r`, 0 inside it. */
function rectGapTo(r: Rect, p: XY): number {
  const dx = Math.max(r.minX - p[0], 0, p[0] - r.maxX);
  const dy = Math.max(r.minY - p[1], 0, p[1] - r.maxY);
  return Math.hypot(dx, dy);
}

/**
 * The Mercator distance from `p` to the nearest tile that is not land, at most `limit`: water,
 * a tile no chart covers, or one whose block is not loaded and may hold water. Nearest first, so
 * a tile farther than the nearest found is not walked.
 */
function nearestWater(store: NodeStore, p: XY, limit: number, walked: Walked): number {
  let best = limit;
  const visit = (z: number, x: number, y: number): void => {
    const rect = tileRect(z, x, y);
    const gap = rectGapTo(rect, p);
    if (gap >= best) {
      return;
    }
    walked.visits++;
    const i = store.find(z, x, y);
    if (i < 0) {
      best = gap;
      return;
    }
    const v = store.values(i);
    const split = store.isSplit(i);
    if (!split || store.standIn(i, z, x, y)) {
      // A leaf is land only when charted at −∞; a block not loaded may hold water anywhere.
      const land = !split && v.dMin === -Infinity && (v.flags & FLAGS.NO_DEPTH) === 0;
      if (!land) {
        best = gap;
      }
      return;
    }
    const kids = CHILDREN.map(([dx, dy]) => [z + 1, 2 * x + dx, 2 * y + dy] as const).sort(
      (m, n) => rectGapTo(tileRect(...m), p) - rectGapTo(tileRect(...n), p)
    );
    for (const k of kids) {
      visit(...k);
    }
  };
  const range = tileRange(store.minZoom, {
    minX: p[0] - limit,
    minY: p[1] - limit,
    maxX: p[0] + limit,
    maxY: p[1] + limit
  });
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      visit(store.minZoom, x, y);
    }
  }
  return best;
}

/**
 * How far along a leg from its end land in a tile `width` metres across is the end's own, with
 * the nearest water `water` metres from the end (`crossesLand`). A tile of no width, one whose
 * block is not loaded, is never the end's own however near the water lies: its land may lie
 * anywhere under it, and the leg is never cleared on a block still to come.
 */
export function ownLandReach(width: number, water: number): number {
  if (width <= 0) {
    return 0;
  }
  const tile = Math.min(width, MAX_END_TILE);
  return Math.max(END_TILES * tile, NEAREST_WATER_SLACK * water + tile);
}

/** The way from `end` to the nearest water, metres (`nearestWater`), within WATER_SEARCH. */
function waterFrom(store: NodeStore, end: LonLat, walked: Walked): number {
  const p = toMercator(end[0], end[1]);
  const cos = Math.cos((end[1] * Math.PI) / 180);
  return nearestWater(store, p, WATER_SEARCH / cos, walked) * cos;
}

/**
 * Whether the leg from→to, drawn straight on the chart, crosses land: its line lies over a land
 * tile that is not the land at one of its own ends. Land at an end is the stretch of land tiles
 * the line runs over from that end without a gap, each as far from the end as `ownReach`: two
 * of its own widths, or one more than NEAREST_WATER_SLACK times the way from the end to the
 * nearest water. A boat alongside a quay lies in the land tile the shore is drawn in, about 5 m
 * wide in a cell that charts no land (`shore.ts`) and a leaf wide in one that does, and a point
 * put on land, a destination clicked on the shore of a harbour, leaves it about the nearest
 * way. Past that, or after water, land is crossed: a breakwater is not left through to the
 * water behind it from beside it.
 *
 * A leg across ±180° is not walked: with land in its corridor it is taken to cross it.
 */
export function crossesLand(
  store: NodeStore,
  from: LonLat,
  to: LonLat,
  walked: Walked = { visits: 0 }
): boolean {
  if (Math.abs(to[0] - from[0]) > 180) {
    return true;
  }
  const a = toMercator(from[0], from[1]);
  const b = toMercator(to[0], to[1]);
  const cos = Math.cos((((from[1] + to[1]) / 2) * Math.PI) / 180);
  const land = landUnder(store, a, b, cos, walked);
  const at = (t: number): LonLat =>
    fromMercator(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  // Each end's reach is found once, from the first loaded stretch at it: the tile it lies in. A
  // stretch of no width, a block not loaded, is never the end's own (`ownLandReach`): it does
  // not take the reach another stretch gave the end.
  const reaches = new Map<LonLat, number>();
  const near = (end: LonLat, t: number, s: Stretch): boolean => {
    if (s.width <= 0) {
      return haversine(end, at(t)) <= ownLandReach(s.width, 0);
    }
    let r = reaches.get(end);
    if (r === undefined) {
      r = ownLandReach(s.width, waterFrom(store, end, walked));
      reaches.set(end, r);
    }
    return haversine(end, at(t)) <= r;
  };
  const own = new Set<Stretch>();
  let reach = 0;
  for (const s of land) {
    if (s.from > reach + JOIN || !near(from, s.to, s)) {
      break;
    }
    own.add(s);
    reach = Math.max(reach, s.to);
  }
  reach = 1;
  for (const s of [...land].reverse()) {
    if (s.to < reach - JOIN || !near(to, s.from, s)) {
      break;
    }
    own.add(s);
    reach = Math.min(reach, s.from);
  }
  return own.size < land.length;
}
