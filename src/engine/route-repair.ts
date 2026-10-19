import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS } from "../foundation/geo";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import { vesselTerms } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import { minDepthWithChartPosition } from "../spatial/chart-position";
import { footprintGeom } from "../spatial/pyramid";
import type { LegResult, RouteCheckInput } from "./route-check";
import { checkLeg, checkRoute, checkRouteYielding, UNCHECKED } from "./route-check";

/**
 * Route repair (plan §4.11): for a leg that fails, Theta* over a local cost
 * grid finds an any-angle path around the shoal; Douglas–Peucker then
 * drops waypoints only where the simplified legs still pass. The answer is
 * the inserted waypoints, a suggestion: existing points are never moved.
 */

export interface RepairOptions {
  /** Legs searched per request at most; bounds the work per request. */
  maxLegs: number;
  /** Cells on the grid's longer side at most; bounds the work per leg. */
  maxCells: number;
  /** Cells are never smaller than this, metres. */
  minCell: number;
  /** The grid reaches this far beyond the leg on every side, as a fraction of its length. */
  margin: number;
  /** ... and at least this many metres. */
  minMargin: number;
  /** Cost weight of P below the threshold: cost = 1 + alpha · P / threshold. */
  alpha: number;
}

export const DEFAULT_REPAIR: RepairOptions = {
  maxLegs: 10,
  maxCells: 120,
  minCell: 10,
  margin: 0.5,
  minMargin: 300,
  alpha: 10
};

export interface LegRepair {
  index: number;
  /** Waypoints to insert between the leg's endpoints; empty when none were found. */
  waypoints: LonLat[];
  /** The legs the waypoints make, re-checked like any route. */
  legs: LegResult[];
  /** Why no repair was found. */
  reason?: string;
}

/**
 * Local east/north metres around an origin; exact enough over a leg's
 * window. Both directions use the same sphere, so a cell centre maps back
 * to the cell it came from.
 */
interface Frame {
  origin: LonLat;
  toXY(p: LonLat): [number, number];
  toLonLat(x: number, y: number): LonLat;
}

function frameAt(origin: LonLat): Frame {
  const k = Math.PI / 180;
  const cos = Math.cos(origin[1] * k);
  return {
    origin,
    toXY: (p) => [
      (p[0] - origin[0]) * k * EARTH_RADIUS * cos,
      (p[1] - origin[1]) * k * EARTH_RADIUS
    ],
    toLonLat: (x, y) => [
      origin[0] + x / (k * EARTH_RADIUS * cos),
      origin[1] + y / (k * EARTH_RADIUS)
    ]
  };
}

interface Grid {
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

export function repairLeg(
  index: ChartIndex,
  input: RouteCheckInput,
  leg: LegResult,
  opts: RepairOptions = DEFAULT_REPAIR
): LegRepair {
  const speed = input.speeds[leg.index] as number;
  const wl = input.waterLevel(Date.parse(leg.eta.start), Date.parse(leg.eta.end), [
    leg.from,
    leg.to
  ]);
  const terms = vesselTerms(input.vessel, { speed, waveHeight: input.waveHeight }, input.dynamics);
  const risk = { threshold: thresholdDepth(terms, wl), sigmaExtra: sigmaExtra(terms, wl) };
  const corridor = input.xteLimit + input.planningBuffer;
  const grid = gridFor(leg.from, leg.to, corridor, opts);
  const costOf = (i: number): number => {
    if (!grid.known[i]) {
      grid.known[i] = 1;
      const cx = grid.x0 + ((i % grid.nx) + 0.5) * grid.cell;
      const cy = grid.y0 + (Math.floor(i / grid.nx) + 0.5) * grid.cell;
      const at = footprintGeom([grid.frame.toLonLat(cx, cy)]);
      const { result: r } = minDepthWithChartPosition(index.pyramid, at, {
        bufferMetres: corridor + grid.cell / 2,
        risk
      });
      const unchecked = (r.flags & UNCHECKED) !== 0;
      grid.cost[i] =
        unchecked || r.maxRisk >= input.probability
          ? Infinity
          : 1 + (opts.alpha * r.maxRisk) / input.probability;
    }
    return grid.cost[i] as number;
  };
  const path = thetaStar(grid, leg.from, leg.to, costOf);
  if (!path) {
    return {
      index: leg.index,
      waypoints: [],
      legs: [],
      reason: "no passable path in the search window"
    };
  }
  const check = (points: LonLat[]): LegResult[] =>
    checkRoute(
      index,
      {
        ...input,
        coordinates: points,
        departure: Date.parse(leg.eta.start),
        speeds: points.slice(1).map(() => speed)
      },
      Date.parse(leg.eta.start)
    ).legs;
  const points = simplify(path, (pts) => check(pts).every((l) => l.status === "ok"));
  const legs = check(points);
  const ok = legs.every((l) => l.status === "ok");
  return {
    index: leg.index,
    waypoints: ok ? points.slice(1, -1) : [],
    legs: ok ? legs : [],
    reason: ok ? undefined : "the path found does not pass the corridor check"
  };
}

function gridFor(a: LonLat, b: LonLat, corridor: number, opts: RepairOptions): Grid {
  const frame = frameAt(a);
  const [bx, by] = frame.toXY(b);
  const length = Math.hypot(bx, by);
  const margin = Math.max(opts.minMargin, opts.margin * length, 2 * corridor);
  const x0 = Math.min(0, bx) - margin;
  const y0 = Math.min(0, by) - margin;
  const w = Math.abs(bx) + 2 * margin;
  const h = Math.abs(by) + 2 * margin;
  const cell = Math.max(opts.minCell, Math.max(w, h) / opts.maxCells);
  const nx = Math.ceil(w / cell);
  const ny = Math.ceil(h / cell);
  return {
    frame,
    x0,
    y0,
    cell,
    nx,
    ny,
    cost: new Float64Array(nx * ny),
    known: new Uint8Array(nx * ny)
  };
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

  /** Cells from start to goal, or undefined when the goal cannot be reached. */
  search(start: number): number[] | undefined {
    this.g[start] = 0;
    this.parent[start] = start;
    this.open.push(start, this.h(start));
    while (this.open.size > 0) {
      const s = this.open.pop();
      if (s === this.goal) {
        break;
      }
      if (this.closed[s]) {
        continue;
      }
      this.closed[s] = 1;
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

function thetaStar(
  g: Grid,
  from: LonLat,
  to: LonLat,
  costOf: (i: number) => number
): LonLat[] | undefined {
  const cellOf = (p: LonLat): number => {
    const [x, y] = g.frame.toXY(p);
    const cx = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.cell)));
    const cy = Math.min(g.ny - 1, Math.max(0, Math.floor((y - g.y0) / g.cell)));
    return cy * g.nx + cx;
  };
  const start = cellOf(from);
  const goal = cellOf(to);
  if (costOf(start) === Infinity || costOf(goal) === Infinity) {
    return undefined;
  }
  const cells = new ThetaStar(g, costOf, goal).search(start);
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

/** Perpendicular distance from p to the line a–b, metres, at route scale. */
function offLine(p: LonLat, a: LonLat, b: LonLat): number {
  const f = frameAt(a);
  const [px, py] = f.toXY(p);
  const [bx, by] = f.toXY(b);
  const len = Math.hypot(bx, by);
  return len === 0 ? Math.hypot(px, py) : Math.abs(px * by - py * bx) / len;
}

/**
 * Douglas–Peucker with a veto: a span becomes its chord when `passes`
 * accepts the chord, else it splits at the point farthest from the chord.
 * Simplification can therefore never make a leg fail.
 */
export function simplify(points: LonLat[], passes: (pts: LonLat[]) => boolean): LonLat[] {
  const keep = (lo: number, hi: number): LonLat[] => {
    const a = points[lo] as LonLat;
    const b = points[hi] as LonLat;
    if (hi - lo < 2 || passes([a, b])) {
      return [a, b];
    }
    let far = lo + 1;
    let dist = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = offLine(points[i] as LonLat, a, b);
      if (d > dist) {
        dist = d;
        far = i;
      }
    }
    return [...keep(lo, far).slice(0, -1), ...keep(far, hi)];
  };
  return keep(0, points.length - 1);
}

export interface RouteRepair {
  repairs: LegRepair[];
  /**
   * The route with every suggested waypoint inserted, checked as a whole:
   * a detour delays the legs after it, so they are checked at their new times.
   */
  route: { coordinates: LonLat[]; legs: LegResult[] };
}

/**
 * Repairs the failing or marginal legs of a route in order, the first
 * `maxLegs` of them; the rest get a reason. Each leg is checked at the time
 * the repairs before it bring the boat there, so a leg a detour makes late
 * is repaired or reported as it is then. `pause` runs after each searched
 * leg so a caller on the event loop can let other work in between.
 */
export async function repairRoute(
  index: ChartIndex,
  input: RouteCheckInput,
  opts: RepairOptions = DEFAULT_REPAIR,
  pause: () => Promise<void> = () => Promise.resolve()
): Promise<RouteRepair> {
  const repairs: LegRepair[] = [];
  const coordinates: LonLat[] = [input.coordinates[0] as LonLat];
  const speeds: number[] = [];
  let searched = 0;
  let t = input.departure;
  for (let i = 0; i + 1 < input.coordinates.length; i++) {
    const { leg } = checkLeg(index, input, i, t);
    let repair: LegRepair | undefined;
    if ((leg.status === "fail" || leg.status === "marginal") && searched >= opts.maxLegs) {
      repairs.push({
        index: i,
        waypoints: [],
        legs: [],
        reason: `not searched: at most ${opts.maxLegs} legs are repaired per request`
      });
    } else if (leg.status === "fail" || leg.status === "marginal") {
      searched += 1;
      repair = repairLeg(index, input, leg, opts);
      repairs.push(repair);
      await pause();
    }
    const waypoints = repair?.waypoints ?? [];
    coordinates.push(...waypoints, leg.to);
    speeds.push(...[...waypoints, leg.to].map(() => input.speeds[i] as number));
    t = Date.parse((waypoints.length > 0 ? repair?.legs.at(-1) : leg)?.eta.end as string);
  }
  const repaired = { ...input, coordinates, speeds };
  const { legs } = await checkRouteYielding(index, repaired, input.departure, pause);
  return { repairs, route: { coordinates, legs } };
}
