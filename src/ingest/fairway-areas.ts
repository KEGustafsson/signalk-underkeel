/**
 * The swept areas `fairway-gaps.ts` samples its lines against, in a local plane of metres, each
 * with the boxes that let a point or a line's segment be tested against the areas near it alone.
 */

export type XY = [number, number];

export type Bounds = [number, number, number, number];

export interface Area {
  id: string;
  depth: number;
  reference: string | undefined;
  /** Outer rings and holes, in the local plane. */
  polygons: XY[][][];
  /** The box of each polygon's outer ring, grown by BOX_MARGIN. */
  boxes: Bounds[];
  /** The box of every `boxes`. */
  box: Bounds;
}

/**
 * How far past a ring's box a point is still tested against the ring, metres: the crossing
 * `inRing` computes for an edge is within rounding of the edge, far less than this, so a point
 * further out than it is in no ring of the box.
 */
const BOX_MARGIN = 1e-6;

export function inRing(p: XY, ring: XY[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as XY;
    const [xj, yj] = ring[j] as XY;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      c = !c;
    }
  }
  return c;
}

const within = (p: XY, b: Bounds): boolean =>
  p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** Whether `p` lies in a polygon of `a`: only one whose box holds it is walked. */
export function inArea(p: XY, a: Area): boolean {
  for (const [k, rings] of a.polygons.entries()) {
    if (!within(p, a.boxes[k] as Bounds) || !inRing(p, rings[0] as XY[])) {
      continue;
    }
    if (!rings.slice(1).some((h) => inRing(p, h))) {
      return true;
    }
  }
  return false;
}

const EMPTY: Bounds = [Infinity, Infinity, -Infinity, -Infinity];

/** The box of `ring` grown by BOX_MARGIN; EMPTY for no ring. */
export function boxOf(ring: XY[] | undefined): Bounds {
  const b: Bounds = [...EMPTY];
  for (const [x, y] of ring ?? []) {
    b[0] = Math.min(b[0], x - BOX_MARGIN);
    b[1] = Math.min(b[1], y - BOX_MARGIN);
    b[2] = Math.max(b[2], x + BOX_MARGIN);
    b[3] = Math.max(b[3], y + BOX_MARGIN);
  }
  return b;
}

export const unionOf = (boxes: Bounds[]): Bounds =>
  boxes.reduce<Bounds>(
    (u, b) => [
      Math.min(u[0], b[0]),
      Math.min(u[1], b[1]),
      Math.max(u[2], b[2]),
      Math.max(u[3], b[3])
    ],
    [...EMPTY]
  );

/**
 * The areas, by index in their order, whose box meets the box of segment ab: no other area holds
 * a point of the segment. A line of some hundred kilometres is sampled every STEP metres, and
 * each sample tested against every swept area of a 30 km box took 24 s of a 33 s download.
 */
export function areasNear(a: XY, b: XY, areas: Area[]): number[] {
  const [x0, x1] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]];
  const [y0, y1] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]];
  const out: number[] = [];
  for (const [k, { box }] of areas.entries()) {
    if (box[0] <= x1 && box[2] >= x0 && box[1] <= y1 && box[3] >= y0) {
      out.push(k);
    }
  }
  return out;
}
