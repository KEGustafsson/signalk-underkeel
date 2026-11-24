import type { Rect, XY } from "../foundation/geo";
import { SEAM_TOLERANCE } from "../foundation/area-cover";
import { segmentIntersectsRect, segmentRectSpan } from "../foundation/geometry";
import type { PolygonIndex, RingIndex } from "./polygon-index";
import { inPolygon, ringEdgesNear } from "./polygon-index";

/**
 * The shore of a cell that charts no land (the Traficom WFS): there the land is what the depth
 * areas leave open. A tile is one value, and read as the depth of the areas reaching it, a
 * breakwater, a spit or the tip of a point narrower than the tile was water charted at their
 * shallowest: a leg across it crossed no land. So a leaf its depth areas reach and, together,
 * leave part open is a shore tile. It splits to the edge zoom (`build-items.ts`), and a tile
 * there that the areas do not cover is land: every point no depth area holds lies in a land
 * tile, and water is lost only within one edge-zoom tile of the shore.
 *
 * Whether the areas cover a tile is area-cover.ts `areasCover`, answered here from the edges of
 * the areas in the leaf, gathered once (`shoreOf`): an edge's own area lies on the side its
 * ring's direction gives, where `areasCover` tests a point in the polygon on each side of every
 * edge, for every tile.
 */

/** A feature reaching a tile, as the build classes it. */
interface Reaching {
  item: { shape: PolygonIndex[] | undefined; f: { advisory?: boolean; dredged?: boolean } };
  full: boolean;
}

/** As area-cover.ts: an edge's box this far from the tile does not touch it. */
const TOUCH_MARGIN = 1e-3;
/** As area-cover.ts: a shorter edge is not matched against its neighbours. */
const MIN_SHARED_EDGE = 1e-3;
const LEFT = 1;
const RIGHT = 2;

/** An edge from its lesser end, and the sides the areas it bounds lie on. */
interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  sides: number;
}

/** The depth areas reaching a tile, and their edges in it that bound an area on one side only. */
export interface Shore {
  polys: readonly PolygonIndex[];
  /** Undefined when an edge in the tile is too short to match: `areasCover` then decides. */
  alone: Edge[] | undefined;
}

const turns = new WeakMap<RingIndex, boolean>();

/** Whether the ring runs anticlockwise (x east, y north): the sign of its shoelace area. */
function turnsLeft(ri: RingIndex): boolean {
  let left = turns.get(ri);
  if (left === undefined) {
    const x0 = ri.xy[0] as number;
    const y0 = ri.xy[1] as number;
    let twice = 0;
    for (let i = 0, j = ri.n - 1; i < ri.n; j = i++) {
      twice +=
        ((ri.xy[2 * j] as number) - x0) * ((ri.xy[2 * i + 1] as number) - y0) -
        ((ri.xy[2 * i] as number) - x0) * ((ri.xy[2 * j + 1] as number) - y0);
    }
    left = twice > 0;
    turns.set(ri, left);
  }
  return left;
}

/**
 * Adds the edge p→q, its polygon on its `left` or right, to `edges`: one entry for edges that
 * run between the same two vertices. False for one too short to match.
 */
function addEdge(edges: Edge[], p: XY, q: XY, left: boolean, rect: Rect): boolean {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len === 0 || !segmentIntersectsRect(p, q, rect)) {
    return true;
  }
  if (len < MIN_SHARED_EDGE) {
    return false;
  }
  const forward = p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]);
  const [a, b] = forward ? [p, q] : [q, p];
  const side = left === forward ? LEFT : RIGHT;
  // A tile SHORE_ABOVE the leaf holds tens of edges: a walk of them is quicker than a key each.
  for (const e of edges) {
    if (e.ax === a[0] && e.ay === a[1] && e.bx === b[0] && e.by === b[1]) {
      e.sides |= side;
      return true;
    }
  }
  edges.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], sides: side });
  return true;
}

/**
 * The shore in the tile `rect` of the depth area polygons reaching it. The polygon lies on the
 * left of an anticlockwise outer ring's edges and of a clockwise hole's.
 */
export function shoreOf(polys: readonly PolygonIndex[], rect: Rect): Shore {
  const edges: Edge[] = [];
  let matched = true;
  for (const p of polys) {
    const rings: [RingIndex, boolean][] = [
      [p.outer, turnsLeft(p.outer)],
      ...p.holes.map((h): [RingIndex, boolean] => [h, !turnsLeft(h)])
    ];
    for (const [ring, left] of rings) {
      ringEdgesNear(ring, rect, TOUCH_MARGIN, (a, b) => {
        matched = addEdge(edges, a, b, left, rect);
        return matched;
      });
      if (!matched) {
        return { polys, alone: undefined };
      }
    }
  }
  return { polys, alone: edges.filter((e) => e.sides !== (LEFT | RIGHT)) };
}

const inside = (polys: readonly PolygonIndex[], x: number, y: number): boolean =>
  polys.some((p) => inPolygon(x, y, p));

/**
 * Whether no area holds the point SEAM_TOLERANCE off the middle of what `rect` holds of the
 * edge, on the side its own area is not: the areas then leave the tile open there by more than
 * a seam. A point of the line `areasCover` follows along that side, so open here is open there.
 */
function openBeside(e: Edge, polys: readonly PolygonIndex[], rect: Rect): boolean {
  const span = segmentRectSpan([e.ax, e.ay], [e.bx, e.by], rect);
  if (!span) {
    return false;
  }
  const dx = e.bx - e.ax;
  const dy = e.by - e.ay;
  const len = Math.hypot(dx, dy);
  const out = e.sides === LEFT ? -1 : 1;
  const t = (span[0] + span[1]) / 2;
  const x = e.ax + dx * t + (-dy / len) * SEAM_TOLERANCE * out;
  const y = e.ay + dy * t + (dx / len) * SEAM_TOLERANCE * out;
  return !inside(polys, x, y);
}

const edgesIn = (edges: readonly Edge[], rect: Rect): Edge[] =>
  edges.filter((e) => segmentIntersectsRect([e.ax, e.ay], [e.bx, e.by], rect));

/** The areas cover the tile, seams aside. */
export const COVERED = 0;
/** No area holds any of the tile: land all over. */
export const OPEN = 1;
/** The shore crosses the tile. */
export const MIXED = 2;

/**
 * How the areas of `shore` lie over `rect`, the leaf it was gathered in or a tile inside it.
 * `covers` is `areasCover` over those areas, asked only where the edges do not decide: one too
 * short to match, or edges that bound their own area alone with other areas beside each (a seam
 * drawn with other vertices on its two sides, an area laid over another).
 */
export function shoreAt(shore: Shore, rect: Rect, covers: (rect: Rect) => boolean): number {
  if (!shore.alone) {
    return covers(rect) ? COVERED : MIXED;
  }
  const near = edgesIn(shore.alone, rect);
  if (near.length === 0) {
    // No boundary of the areas together crosses the tile: its centre decides, as `areasCover`.
    const cx = (rect.minX + rect.maxX) / 2;
    const cy = (rect.minY + rect.maxY) / 2;
    return inside(shore.polys, cx, cy) ? COVERED : OPEN;
  }
  return near.some((e) => openBeside(e, shore.polys, rect)) || !covers(rect) ? MIXED : COVERED;
}

/** A tile's depth areas in a cell that charts no land, and their edges in it. */
export interface ShoreIn<H> {
  areas: H[];
  edges: Shore;
}

/** `areasCover` of `areas` over `rect`. */
type Covers<H> = (areas: H[], rect: Rect) => boolean;

const gathered = <H extends Reaching>(areas: H[], rect: Rect): ShoreIn<H> => ({
  areas,
  edges: shoreOf(
    areas.flatMap((h) => h.item.shape ?? []),
    rect
  )
});

/** `shoreAt` for the areas of `s` over `rect`. */
export const shoreHere = <H>(s: ShoreIn<H>, rect: Rect, covers: Covers<H>): number =>
  shoreAt(s.edges, rect, (r) => covers(s.areas, r));

/**
 * Zooms above the leaf at which a tile's shore is gathered for the leaves under it: about 76 m
 * across at 60° N for a leaf of zoom 20. Gathered higher, each leaf sorts through more edges
 * than the walks saved: 3 and 4 zooms above built the Parainen region no faster.
 */
export const SHORE_ABOVE = 2;

/**
 * The shore of the advisory depth areas among `areas`, those reaching a tile SHORE_ABOVE the
 * leaf zoom, for the leaves under it: null when they cover it, so no leaf under it is asked.
 * Most leaves a depth contour crosses lie under such a tile, and the areas' edges are walked
 * once for all of them.
 *
 * The areas that are not dredged are asked first. A dredged area lies over the depth area that
 * charts its channel (`give-way.ts`), so its outline bounds it alone in open water, where only
 * `covers` could tell it from a shore; where the others cover the tile it is never asked.
 */
export function shoreAbove<H extends Reaching>(
  areas: H[],
  rect: Rect,
  covers: Covers<H>
): ShoreIn<H> | null {
  const own = areas.filter((h) => h.item.f.advisory === true);
  if (own.length === 0 || own.some((h) => h.full)) {
    return null;
  }
  const plain = own.filter((h) => h.item.f.dredged !== true);
  if (plain.length > 0 && plain.length < own.length) {
    if (shoreHere(gathered(plain, rect), rect, covers) === COVERED) {
      return null;
    }
  }
  const s = gathered(own, rect);
  return shoreHere(s, rect, covers) === COVERED ? null : s;
}

/**
 * The shore in the leaf `rect`, when one crosses it: `areas`, the depth areas reaching it in a
 * cell that charts no land, together leave part of it open. Read from `above` (`shoreAbove`)
 * when every area is of that cell, else from the areas' own edges in the leaf.
 */
export function shoreIn<H extends Reaching>(
  areas: H[],
  rect: Rect,
  above: ShoreIn<H> | null | undefined,
  covers: Covers<H>
): ShoreIn<H> | undefined {
  if (areas.length === 0 || areas.some((h) => h.full)) {
    return undefined;
  }
  const s =
    above !== undefined && areas.every((h) => h.item.f.advisory === true)
      ? above
      : gathered(areas, rect);
  return s === null || shoreHere(s, rect, covers) === COVERED ? undefined : s;
}

export type Tile = [z: number, x: number, y: number];

const CHILDREN = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1]
] as const;

/**
 * The tiles under the shore leaf `t`, down to `deepest`: land where the depth areas leave any
 * of a tile open (`at`, `shoreHere` of the leaf's shore), and elsewhere the leaf's own reading,
 * the shallowest of all that reaches it. So the shore is drawn at the edge zoom and the depths
 * beside it at the leaf zoom, as everywhere, with one walk of the areas' edges for the leaf and
 * none for the tiles in it. `put` stores a tile and gives what its parent folds.
 */
export function shoreTiles<E>(
  t: Tile,
  deepest: number,
  at: (z: number, x: number, y: number) => number,
  put: { leaf: (t: Tile, land: boolean) => E; split: (t: Tile, children: E[]) => E }
): E {
  const visit = (z: number, x: number, y: number): E => {
    const how = z === t[0] ? MIXED : at(z, x, y);
    if (how === COVERED) {
      return put.leaf([z, x, y], false);
    }
    if (how === OPEN || z >= deepest) {
      return put.leaf([z, x, y], true);
    }
    return put.split(
      [z, x, y],
      CHILDREN.map(([dx, dy]) => visit(z + 1, 2 * x + dx, 2 * y + dy))
    );
  };
  return visit(...t);
}
