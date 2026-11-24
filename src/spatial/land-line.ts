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

/** Stretches closer than this, as a fraction of the leg, run on from one another. */
const JOIN = 1e-9;
/** Land at a leg's end is its own berth as far as this many widths of the tile it lies in. */
const END_TILES = 2;
/** A land tile counts as at most this wide, metres: a point far inland is not at a berth. */
const MAX_END_TILE = 20;

/**
 * The land tiles the straight line a→b on the chart passes over, as stretches of it, in
 * order. Land is a tile with a depth of −∞ that is charted: one with no chart is not land. A
 * tile whose block is not loaded and holds land counts as land all over, of no width: the line
 * crosses it wherever it lies, so a leg is never cleared on a block still to come.
 */
function landUnder(store: NodeStore, a: XY, b: XY, cos: number): Stretch[] {
  const out: Stretch[] = [];
  const visit = (z: number, x: number, y: number): void => {
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

/**
 * Whether the leg from→to, drawn straight on the chart, crosses land: its line lies over a land
 * tile that is not the land at one of its own ends. Land at an end is the stretch of land tiles
 * the line runs over from that end without a gap, each as far as END_TILES of its own widths
 * from the end: a boat alongside a quay lies in the land tile the shore is drawn in, about 5 m
 * wide in a cell that charts no land (`shore.ts`) and a leaf wide in one that does. Past that,
 * or after water, land is crossed: a point put farther inland is not at a berth, and a
 * breakwater wider than a tile is not left through.
 *
 * A leg across ±180° is not walked: with land in its corridor it is taken to cross it.
 */
export function crossesLand(store: NodeStore, from: LonLat, to: LonLat): boolean {
  if (Math.abs(to[0] - from[0]) > 180) {
    return true;
  }
  const a = toMercator(from[0], from[1]);
  const b = toMercator(to[0], to[1]);
  const cos = Math.cos((((from[1] + to[1]) / 2) * Math.PI) / 180);
  const land = landUnder(store, a, b, cos);
  const at = (t: number): LonLat =>
    fromMercator(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  const near = (end: LonLat, t: number, s: Stretch): boolean =>
    haversine(end, at(t)) <= END_TILES * Math.min(s.width, MAX_END_TILE);
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
