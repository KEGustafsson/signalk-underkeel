import type { Rect } from "../foundation/geo";
import type { PolygonGeom, Ring } from "../foundation/geometry";
import { segmentRectDistance } from "../foundation/geometry";

/**
 * Polygon tests for the pyramid build, indexed once per polygon. Each function
 * returns exactly what its counterpart in foundation/geometry.ts returns, so the
 * built pyramid is unchanged; the box and the edge grid only skip the edges and
 * points whose result the full walk would discard. A real land area of 24 334
 * vertices reaches every tile of its cell, and the full walk tested every vertex
 * for each of them.
 */

/** Rings with fewer vertices are walked whole. */
const GRID_MIN = 64;

/**
 * A rectangle this far (Mercator metres) outside a polygon's box takes the full
 * test. A ray-cast crossing can round past the box by about 1e-8 m.
 */
const BOX_MARGIN = 1e-3;

/** Uniform grid over a ring's box; edge i runs from vertex i - 1 (n - 1 for i = 0) to vertex i. */
interface EdgeGrid {
  size: number;
  minX: number;
  minY: number;
  cellW: number;
  cellH: number;
  /** Edges whose y-extent reaches each row, as CSR: rowEdges[rowStart[r] .. rowStart[r + 1]). */
  rowStart: Int32Array;
  rowEdges: Int32Array;
  /** Edges whose box reaches each cell, row-major, as CSR. */
  cellStart: Int32Array;
  cellEdges: Int32Array;
  /** Per-edge visit marks, so an edge in several cells is tested once per query. */
  seen: Uint32Array;
  visit: number;
}

/** A ring as x0, y0, x1, y1, …: 16 bytes a vertex, where an [x, y] array per vertex took 50–70. */
interface RingIndex {
  xy: Float64Array;
  n: number;
  box: Rect;
  grid: EdgeGrid | undefined;
}

export interface PolygonIndex {
  box: Rect;
  outer: RingIndex;
  holes: RingIndex[];
}

function ringBox(xy: Float64Array): Rect {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let k = 0; k < xy.length; k += 2) {
    box.minX = Math.min(box.minX, xy[k] as number);
    box.maxX = Math.max(box.maxX, xy[k] as number);
    box.minY = Math.min(box.minY, xy[k + 1] as number);
    box.maxY = Math.max(box.maxY, xy[k + 1] as number);
  }
  return box;
}

/** Vertex before i, closing the ring. */
const prev = (n: number, i: number): number => (i === 0 ? n - 1 : i - 1);

// Monotone in the coordinate, so an edge reaching a coordinate is filed under its cell.
const column = (g: EdgeGrid, x: number): number =>
  Math.min(g.size - 1, Math.max(0, Math.floor((x - g.minX) / g.cellW)));
const row = (g: EdgeGrid, y: number): number =>
  Math.min(g.size - 1, Math.max(0, Math.floor((y - g.minY) / g.cellH)));

const xOf = (ri: RingIndex, i: number): number => ri.xy[2 * i] as number;
const yOf = (ri: RingIndex, i: number): number => ri.xy[2 * i + 1] as number;

function edgeSpan(g: EdgeGrid, ri: RingIndex, i: number): [number, number, number, number] {
  const j = prev(ri.n, i);
  return [
    column(g, Math.min(xOf(ri, j), xOf(ri, i))),
    column(g, Math.max(xOf(ri, j), xOf(ri, i))),
    row(g, Math.min(yOf(ri, j), yOf(ri, i))),
    row(g, Math.max(yOf(ri, j), yOf(ri, i)))
  ];
}

/** Fills a CSR table in two passes: count per slot, then place. */
function fillTable(
  slots: number,
  edges: number,
  each: (i: number, add: (slot: number) => void) => void
): { start: Int32Array; items: Int32Array } {
  const count = new Int32Array(slots);
  for (let i = 0; i < edges; i++) {
    each(i, (slot) => (count[slot] = (count[slot] as number) + 1));
  }
  const start = new Int32Array(slots + 1);
  for (let s = 0; s < slots; s++) {
    start[s + 1] = (start[s] as number) + (count[s] as number);
  }
  const items = new Int32Array(start[slots] as number);
  const next = start.slice(0, slots);
  for (let i = 0; i < edges; i++) {
    each(i, (slot) => {
      const at = next[slot] as number;
      items[at] = i;
      next[slot] = at + 1;
    });
  }
  return { start, items };
}

function edgeGrid(ri: RingIndex): EdgeGrid {
  const box = ri.box;
  const size = Math.max(2, Math.ceil(Math.sqrt(ri.n / 2)));
  const g: EdgeGrid = {
    size,
    minX: box.minX,
    minY: box.minY,
    cellW: (box.maxX - box.minX) / size || 1,
    cellH: (box.maxY - box.minY) / size || 1,
    rowStart: new Int32Array(0),
    rowEdges: new Int32Array(0),
    cellStart: new Int32Array(0),
    cellEdges: new Int32Array(0),
    seen: new Uint32Array(ri.n),
    visit: 0
  };
  const rows = fillTable(size, ri.n, (i, add) => {
    const [, , y0, y1] = edgeSpan(g, ri, i);
    for (let y = y0; y <= y1; y++) {
      add(y);
    }
  });
  const cells = fillTable(size * size, ri.n, (i, add) => {
    const [x0, x1, y0, y1] = edgeSpan(g, ri, i);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        add(y * size + x);
      }
    }
  });
  g.rowStart = rows.start;
  g.rowEdges = rows.items;
  g.cellStart = cells.start;
  g.cellEdges = cells.items;
  return g;
}

function indexRing(ring: Ring): RingIndex {
  const xy = new Float64Array(2 * ring.length);
  ring.forEach((p, i) => {
    xy[2 * i] = p[0];
    xy[2 * i + 1] = p[1];
  });
  const ri: RingIndex = { xy, n: ring.length, box: ringBox(xy), grid: undefined };
  ri.grid = ri.n >= GRID_MIN ? edgeGrid(ri) : undefined;
  return ri;
}

export function indexPolygon(poly: PolygonGeom): PolygonIndex {
  const outer = indexRing(poly.outer);
  return { box: outer.box, outer, holes: poly.holes.map(indexRing) };
}

/** The ray-cast step of geometry.ts `inRing` for edge i, a = vertex i, b = the one before. */
function crosses(x: number, y: number, ri: RingIndex, i: number): boolean {
  const j = prev(ri.n, i);
  const ay = yOf(ri, i);
  const by = yOf(ri, j);
  if (ay > y !== by > y) {
    const ax = xOf(ri, i);
    const xCross = ((xOf(ri, j) - ax) * (y - ay)) / (by - ay) + ax;
    return x < xCross;
  }
  return false;
}

/** Even-odd parity is independent of edge order, so only edges spanning y need be tested. */
function inRing(x: number, y: number, ri: RingIndex): boolean {
  let inside = false;
  const g = ri.grid;
  if (!g) {
    for (let i = 0; i < ri.n; i++) {
      inside = crosses(x, y, ri, i) ? !inside : inside;
    }
    return inside;
  }
  if (y < ri.box.minY || y > ri.box.maxY) {
    return false;
  }
  const r = row(g, y);
  for (let k = g.rowStart[r] as number; k < (g.rowStart[r + 1] as number); k++) {
    inside = crosses(x, y, ri, g.rowEdges[k] as number) ? !inside : inside;
  }
  return inside;
}

export function inPolygon(x: number, y: number, p: PolygonIndex): boolean {
  return inRing(x, y, p.outer) && !p.holes.some((h) => inRing(x, y, h));
}

// Edge ends handed to geometry.ts, which reads them and keeps no reference.
const edgeA: [number, number] = [0, 0];
const edgeB: [number, number] = [0, 0];

/** geometry.ts `segmentRectDistanceUpTo` for edge i, from vertex i - 1 to vertex i. */
function edgeDistance(ri: RingIndex, i: number, r: Rect, limit: number): number {
  const j = prev(ri.n, i);
  const ax = xOf(ri, j);
  const ay = yOf(ri, j);
  const bx = xOf(ri, i);
  const by = yOf(ri, i);
  if (
    Math.min(ax, bx) > r.maxX + limit ||
    Math.max(ax, bx) < r.minX - limit ||
    Math.min(ay, by) > r.maxY + limit ||
    Math.max(ay, by) < r.minY - limit
  ) {
    return Infinity;
  }
  edgeA[0] = ax;
  edgeA[1] = ay;
  edgeB[0] = bx;
  edgeB[1] = by;
  return segmentRectDistance(edgeA, edgeB, r);
}

/**
 * Calls `each` once for every edge filed in the cells that `r` grown by `limit`
 * reaches, until it returns false.
 */
function forNearEdges(g: EdgeGrid, r: Rect, limit: number, each: (i: number) => boolean): void {
  const visit = ++g.visit;
  const y1 = row(g, r.maxY + limit);
  const x0 = column(g, r.minX - limit);
  const x1 = column(g, r.maxX + limit);
  for (let y = row(g, r.minY - limit); y <= y1; y++) {
    const end = g.cellStart[y * g.size + x1 + 1] as number;
    for (let k = g.cellStart[y * g.size + x0] as number; k < end; k++) {
      const i = g.cellEdges[k] as number;
      if (g.seen[i] !== visit) {
        g.seen[i] = visit;
        if (!each(i)) {
          return;
        }
      }
    }
  }
}

const near: number[] = [];

/**
 * geometry.ts `pathRectDistance` over a closed ring. An edge outside every
 * cell the grown rectangle reaches returns Infinity in the full walk at any
 * running limit, so folding the others gives the same value: in any order at
 * limit 0, where the running limit stays 0, and in ring order otherwise.
 */
function ringRectDistance(ri: RingIndex, r: Rect, limit: number): number {
  const g = ri.grid;
  const b = ri.box;
  let d = Infinity;
  if (!g || !Number.isFinite(limit)) {
    for (let i = 0; i < ri.n && d > 0; i++) {
      d = Math.min(d, edgeDistance(ri, i, r, Math.min(limit, d)));
    }
    return d;
  }
  if (
    r.minX - limit > b.maxX ||
    r.maxX + limit < b.minX ||
    r.minY - limit > b.maxY ||
    r.maxY + limit < b.minY
  ) {
    return Infinity;
  }
  if (limit === 0) {
    forNearEdges(g, r, 0, (i) => {
      d = Math.min(d, edgeDistance(ri, i, r, 0));
      return d > 0;
    });
    return d;
  }
  near.length = 0;
  forNearEdges(g, r, limit, (i) => near.push(i) > 0);
  near.sort((x, y) => x - y);
  for (let k = 0; k < near.length && d > 0; k++) {
    d = Math.min(d, edgeDistance(ri, near[k] as number, r, Math.min(limit, d)));
  }
  return d;
}

/** geometry.ts `polygonBoundaryRectDistance`. */
export function boundaryRectDistance(p: PolygonIndex, r: Rect, limit: number): number {
  let d = ringRectDistance(p.outer, r, limit);
  for (const hole of p.holes) {
    if (d === 0) {
      break;
    }
    d = Math.min(d, ringRectDistance(hole, r, Math.min(limit, d)));
  }
  return d;
}

/** The polygon's box, grown by `by` plus the margin, misses `r`: no corner in, no edge within `by`. */
function farFrom(p: PolygonIndex, r: Rect, by: number): boolean {
  const m = by + BOX_MARGIN;
  return (
    p.box.minX > r.maxX + m ||
    p.box.maxX < r.minX - m ||
    p.box.minY > r.maxY + m ||
    p.box.maxY < r.minY - m
  );
}

/** `r` reaches past the polygon's box by more than the margin, so a corner of it is outside. */
function sticksOut(p: PolygonIndex, r: Rect): boolean {
  return (
    r.minX < p.box.minX - BOX_MARGIN ||
    r.maxX > p.box.maxX + BOX_MARGIN ||
    r.minY < p.box.minY - BOX_MARGIN ||
    r.maxY > p.box.maxY + BOX_MARGIN
  );
}

function cornersIn(p: PolygonIndex, r: Rect): number {
  return (
    (inPolygon(r.minX, r.minY, p) ? 1 : 0) +
    (inPolygon(r.maxX, r.minY, p) ? 1 : 0) +
    (inPolygon(r.maxX, r.maxY, p) ? 1 : 0) +
    (inPolygon(r.minX, r.maxY, p) ? 1 : 0)
  );
}

/** geometry.ts `polygonRectDistance`. */
function polygonRectDistance(p: PolygonIndex, r: Rect, limit: number): number {
  if (farFrom(p, r, limit)) {
    return Infinity;
  }
  if (
    inPolygon(r.minX, r.minY, p) ||
    inPolygon(r.maxX, r.minY, p) ||
    inPolygon(r.maxX, r.maxY, p) ||
    inPolygon(r.minX, r.maxY, p)
  ) {
    return 0;
  }
  return boundaryRectDistance(p, r, limit);
}

/** geometry.ts `geomRectDistance` for a polygon geometry. */
export function polygonsRectDistance(
  polys: readonly PolygonIndex[],
  r: Rect,
  limit: number
): number {
  let d = Infinity;
  for (const p of polys) {
    d = Math.min(d, polygonRectDistance(p, r, Math.min(limit, d)));
    if (d === 0) {
      break;
    }
  }
  return d;
}

/** geometry.ts `geomContainsRect` for a polygon geometry. */
export function polygonsContainRect(polys: readonly PolygonIndex[], r: Rect): boolean {
  return polys.some(
    (p) => !sticksOut(p, r) && cornersIn(p, r) === 4 && boundaryRectDistance(p, r, 0) > 0
  );
}

export const MISS = 0;
export const PARTIAL = 1;
export const FULL = 2;

/**
 * Both build tests of an area against a tile in one boundary pass:
 * FULL when `polygonsContainRect`, else PARTIAL when `polygonsRectDistance(…, 0)`
 * is 0, else MISS. Per polygon, an edge touching the tile decides "touches,
 * not containing"; otherwise all four corners are tested, as both full tests do.
 */
export function polygonsRectRelation(polys: readonly PolygonIndex[], r: Rect): number {
  let rel = MISS;
  for (const p of polys) {
    if (farFrom(p, r, 0)) {
      continue;
    }
    if (boundaryRectDistance(p, r, 0) === 0) {
      rel = PARTIAL;
      continue;
    }
    const corners = cornersIn(p, r);
    if (corners === 4) {
      return FULL;
    }
    rel = corners > 0 ? PARTIAL : rel;
  }
  return rel;
}
