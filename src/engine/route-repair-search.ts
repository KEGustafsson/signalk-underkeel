import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, wrapLon } from "../foundation/geo";
import type { Steps } from "./route-check";

/** The grid and the Theta* search route repair runs on it (plan §4.11). */

/**
 * Local east/north metres around an origin; exact enough over a leg's
 * window. Both directions use the same sphere, so a cell centre maps back
 * to the cell it came from.
 */
export interface Frame {
  origin: LonLat;
  toXY(p: LonLat): [number, number];
  toLonLat(x: number, y: number): LonLat;
}

/**
 * Longitudes are taken the short way round from the origin, so a grid
 * across 180° spans the leg and not the world, and points mapped back are
 * canonical, since they are returned as waypoints.
 */
export function frameAt(origin: LonLat): Frame {
  const k = Math.PI / 180;
  const cos = Math.cos(origin[1] * k);
  return {
    origin,
    toXY: (p) => [
      wrapLon(p[0] - origin[0]) * k * EARTH_RADIUS * cos,
      (p[1] - origin[1]) * k * EARTH_RADIUS
    ],
    toLonLat: (x, y) => [
      wrapLon(origin[0] + x / (k * EARTH_RADIUS * cos)),
      origin[1] + y / (k * EARTH_RADIUS)
    ]
  };
}

export interface Grid {
  frame: Frame;
  /** South-west corner, metres in the frame. */
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  /** Lazily filled: cost per cell, Infinity when blocked. */
  cost: Float64Array;
  known: Uint8Array;
}

class Heap {
  private readonly items: { node: number; f: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: number, f: number): void {
    const a = this.items;
    a.push({ node, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as { f: number }).f <= f) {
        break;
      }
      [a[i], a[p]] = [a[p] as { node: number; f: number }, a[i] as { node: number; f: number }];
      i = p;
    }
  }

  pop(): number {
    const a = this.items;
    const top = a[0] as { node: number; f: number };
    const last = a.pop() as { node: number; f: number };
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && (a[l] as { f: number }).f < (a[m] as { f: number }).f) {
          m = l;
        }
        if (r < a.length && (a[r] as { f: number }).f < (a[m] as { f: number }).f) {
          m = r;
        }
        if (m === i) {
          break;
        }
        [a[i], a[m]] = [a[m] as { node: number; f: number }, a[i] as { node: number; f: number }];
        i = m;
      }
    }
    return top.node;
  }
}

/** Mean cost along a straight segment, sampled every half cell; Infinity if it crosses a block. */
function lineCost(g: Grid, i: number, j: number, costOf: (i: number) => number): number {
  const [ax, ay] = [i % g.nx, Math.floor(i / g.nx)];
  const [bx, by] = [j % g.nx, Math.floor(j / g.nx)];
  const steps = Math.max(1, Math.ceil(2 * Math.hypot(bx - ax, by - ay)));
  let sum = 0;
  for (let k = 0; k <= steps; k++) {
    const x = Math.round(ax + ((bx - ax) * k) / steps);
    const y = Math.round(ay + ((by - ay) * k) / steps);
    const c = costOf(y * g.nx + x);
    if (c === Infinity) {
      return Infinity;
    }
    sum += c;
  }
  return (sum / (steps + 1)) * Math.hypot(bx - ax, by - ay) * g.cell;
}

/**
 * Expanded cells between yields. An expansion evaluates up to 8 cells and
 * the cells on its lines of sight, each a corridor query, so this keeps a
 * slice to a few milliseconds where one leg's search took up to 174 ms.
 */
const EXPANSIONS_PER_STEP = 256;

/** Theta* over the grid: A* whose nodes link straight to their grandparent when that line is passable. */
class ThetaStar {
  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly open = new Heap();

  constructor(
    private readonly grid: Grid,
    private readonly costOf: (i: number) => number,
    private readonly goal: number
  ) {
    const n = grid.nx * grid.ny;
    this.g = new Float64Array(n).fill(Infinity);
    this.parent = new Int32Array(n).fill(-1);
    this.closed = new Uint8Array(n);
  }

  private h(i: number): number {
    const { nx, cell } = this.grid;
    return (
      Math.hypot((i % nx) - (this.goal % nx), Math.floor(i / nx) - Math.floor(this.goal / nx)) *
      cell
    );
  }

  private neighbours(s: number): number[] {
    const { nx, ny } = this.grid;
    const sx = s % nx;
    const sy = Math.floor(s / nx);
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!(dx === 0 && dy === 0) && x >= 0 && y >= 0 && x < nx && y < ny) {
          out.push(y * nx + x);
        }
      }
    }
    return out;
  }

  private relax(s: number, t: number): void {
    const p = this.parent[s] as number;
    const viaParent = (this.g[p] as number) + lineCost(this.grid, p, t, this.costOf);
    const direct = (this.g[s] as number) + lineCost(this.grid, s, t, this.costOf);
    const [best, via] = viaParent <= direct ? [viaParent, p] : [direct, s];
    if (best < (this.g[t] as number)) {
      this.g[t] = best;
      this.parent[t] = via;
      this.open.push(t, best + this.h(t));
    }
  }

  /**
   * Cells from start to goal, or undefined when the goal cannot be reached;
   * it yields every EXPANSIONS_PER_STEP expanded cells.
   */
  *search(start: number): Steps<number[] | undefined> {
    this.g[start] = 0;
    this.parent[start] = start;
    this.open.push(start, this.h(start));
    let expanded = 0;
    while (this.open.size > 0) {
      const s = this.open.pop();
      if (s === this.goal) {
        break;
      }
      if (this.closed[s]) {
        continue;
      }
      this.closed[s] = 1;
      if (++expanded % EXPANSIONS_PER_STEP === 0) {
        yield;
      }
      for (const t of this.neighbours(s)) {
        if (!this.closed[t] && this.costOf(t) !== Infinity) {
          this.relax(s, t);
        }
      }
    }
    if (this.parent[this.goal] === -1) {
      return undefined;
    }
    const cells = [this.goal];
    for (let c = this.goal; c !== start; c = this.parent[c] as number) {
      cells.push(this.parent[c] as number);
    }
    return cells.reverse();
  }
}

/** The cell `p` lies in, clamped to the grid. */
export function cellOf(g: Grid, p: LonLat): number {
  const [x, y] = g.frame.toXY(p);
  const cx = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.cell)));
  const cy = Math.min(g.ny - 1, Math.max(0, Math.floor((y - g.y0) / g.cell)));
  return cy * g.nx + cx;
}

/** The path from `from` to `to` through the grid's open cells, or undefined when there is none. */
export function* thetaStar(
  g: Grid,
  from: LonLat,
  to: LonLat,
  costOf: (i: number) => number
): Steps<LonLat[] | undefined> {
  const start = cellOf(g, from);
  const goal = cellOf(g, to);
  if (costOf(start) === Infinity || costOf(goal) === Infinity) {
    return undefined;
  }
  const cells = yield* new ThetaStar(g, costOf, goal).search(start);
  if (!cells) {
    return undefined;
  }
  const centre = (i: number): LonLat =>
    g.frame.toLonLat(
      g.x0 + ((i % g.nx) + 0.5) * g.cell,
      g.y0 + (Math.floor(i / g.nx) + 0.5) * g.cell
    );
  // The leg's own endpoints replace the start and goal cell centres.
  return [from, ...cells.slice(1, -1).map(centre), to];
}
