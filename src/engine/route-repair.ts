import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import { vesselTerms } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import { footprintGeom, minDepthOver } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { LegResult, RouteCheckInput, Steps } from "./route-check";
import {
  checkLeg,
  checkRouteYielding,
  corridorRing,
  drain,
  legsSteps,
  UNCHECKED
} from "./route-check";
import type { EndCheck, Grid } from "./route-repair-search";
import { cellCentre, cellOf, frameAt, thetaStar } from "./route-repair-search";
import { queryWork } from "./work";

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
  /**
   * Work one leg's repair may do: its search, simplification checks and
   * final check, in units of work.ts. Sized for about 1.5 s on a Raspberry Pi 4.
   */
  maxWork: number;
  /** The fraction of `maxWork` after which the search stops scoring and the leg is refused. */
  searchShare: number;
  /** The fraction of `maxWork` after which simplification stops removing waypoints. */
  simplifyShare: number;
  /** No further leg is searched once a request's repairs have done this much work. */
  maxRequestWork: number;
}

export const DEFAULT_REPAIR: RepairOptions = {
  maxLegs: 10,
  maxCells: 120,
  minCell: 10,
  margin: 0.5,
  minMargin: 300,
  alpha: 10,
  maxWork: 600_000,
  searchShare: 0.8,
  simplifyShare: 0.9,
  maxRequestWork: 1_800_000
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

/** Where to split a leg, its worst position; empty when the check named none. */
function near(leg: LegResult): string {
  const p = leg.worst?.position;
  return p ? `near [${p[0].toFixed(5)}, ${p[1].toFixed(5)}] (lon, lat)` : "";
}

/** "add a waypoint near [...] to split the leg", without the position when there is none. */
function splitAdvice(leg: LegResult): string {
  return ["add a waypoint", near(leg), "to split the leg, or use a smaller xteLimit"]
    .filter((s) => s !== "")
    .join(" ");
}

const SEARCH_LIMIT = (leg: LegResult): string =>
  `the repair search reached the work limit for one leg; ${splitAdvice(leg)}`;

const CHECK_LIMIT = (leg: LegResult): string =>
  `the path found could not be checked within the work limit for one leg; ${splitAdvice(leg)}`;

const REQUEST_LIMIT =
  "not searched: this request has used its repair work limit; repair this leg in another request";

export function repairLeg(
  index: ChartIndex,
  input: RouteCheckInput,
  leg: LegResult,
  opts: RepairOptions = DEFAULT_REPAIR
): LegRepair {
  return drain(repairSteps(index, input, leg, opts)).repair;
}

/** Work a leg's repair has done so far, in units of work.ts. */
interface Budget {
  work: number;
}

/**
 * `repairLeg` split at every few hundred searched cells and between the
 * corridor queries of its checks, with the work it did (work.ts). The work
 * is counted, never timed, so the answer is the same on any machine; a leg
 * that needs more than `maxWork` is refused with a reason. The benchmark
 * reads the work to calibrate its unit.
 */
export function* repairSteps(
  index: ChartIndex,
  input: RouteCheckInput,
  leg: LegResult,
  opts: RepairOptions
): Steps<{ repair: LegRepair; work: number }> {
  const budget: Budget = { work: 0 };
  const refused = (reason: string) => ({
    repair: { index: leg.index, waypoints: [], legs: [], reason },
    work: budget.work
  });
  const path = yield* searchSteps(index, input, leg, opts, budget);
  if (budget.work >= opts.searchShare * opts.maxWork) {
    return refused(SEARCH_LIMIT(leg));
  }
  if (!path) {
    return refused("no passable path in the search window");
  }
  const speed = input.speeds[leg.index] as number;
  const start = Date.parse(leg.eta.start);
  const pathInput = (points: LonLat[], departure: number): RouteCheckInput => ({
    ...input,
    coordinates: points,
    departure,
    speeds: points.slice(1).map(() => speed)
  });
  const [first, last] = [path[0], path.at(-1)];
  function* passes(pts: LonLat[], departure: number): Steps<boolean> {
    // The leg itself, already checked as fail or marginal from this start time.
    if (pts[0] === first && pts[1] === last) {
      return false;
    }
    // Past its share of the work, simplification keeps the span's points.
    if (budget.work >= opts.simplifyShare * opts.maxWork) {
      return false;
    }
    const c = yield* legsSteps(index, pathInput(pts, departure), departure);
    budget.work += c.work;
    return c.legs[0]?.status === "ok";
  }
  const points = yield* simplifySteps(path, passes, start, speed);
  const fin = yield* legsSteps(index, pathInput(points, start), start, opts.maxWork - budget.work);
  budget.work += fin.work;
  if (!fin.complete) {
    return refused(CHECK_LIMIT(leg));
  }
  const ok = fin.legs.every((l) => l.status === "ok");
  return {
    repair: {
      index: leg.index,
      waypoints: ok ? points.slice(1, -1) : [],
      legs: ok ? fin.legs : [],
      reason: ok ? undefined : "the path found does not pass the corridor check"
    },
    work: budget.work
  };
}

/**
 * Theta* round the leg over its grid; undefined when no path passes or the
 * search's share of the work runs out first (then `budget` has reached it).
 */
function* searchSteps(
  index: ChartIndex,
  input: RouteCheckInput,
  leg: LegResult,
  opts: RepairOptions,
  budget: Budget
): Steps<LonLat[] | undefined> {
  const limit = opts.searchShare * opts.maxWork;
  const speed = input.speeds[leg.index] as number;
  const corridor = input.xteLimit + input.planningBuffer;
  const grid = gridFor(leg.from, leg.to, corridor, opts);
  // A detour is longer than the leg, so the final check reads its later pieces after the leg's
  // own end. The grid takes the lowest level until the boat could have sailed the grid's width
  // and height, a path along the window's edge, so on a falling tide it does not plan through
  // water the final check then finds too shallow.
  const start = Date.parse(leg.eta.start);
  const reach = start + (((grid.nx + grid.ny) * grid.cell) / speed) * 1000;
  const wl = input.waterLevel(start, Math.max(Date.parse(leg.eta.end), reach), [leg.from, leg.to]);
  const terms = vesselTerms(input.vessel, { speed, waveHeight: input.waveHeight }, input.dynamics);
  const risk = { threshold: thresholdDepth(terms, wl), sigmaExtra: sigmaExtra(terms, wl) };
  /** The cost of the water in `geom`; undefined, not queried, once the search's work is spent. */
  const query = (geom: Geom, bufferMetres?: number): number | undefined => {
    if (budget.work >= limit) {
      return undefined;
    }
    const r = minDepthOver(index.pyramid, geom, { bufferMetres, chartPosition: true, risk });
    budget.work += queryWork(r);
    const unchecked = (r.flags & UNCHECKED) !== 0;
    return unchecked || r.maxRisk >= input.probability
      ? Infinity
      : 1 + (opts.alpha * r.maxRisk) / input.probability;
  };
  const score = (at: LonLat, bufferMetres: number) => query(footprintGeom([at]), bufferMetres);
  // The path starts and ends on the leg's own ends, so their cells are scored there with the
  // corridor alone: around the cell centre, grown by half a cell, a shoal hundreds of metres
  // from a waypoint on a long leg's coarse grid would block the whole search. The final check
  // still holds the path to the corridor.
  for (const end of [leg.from, leg.to]) {
    const i = cellOf(grid, end);
    const c = score(end, corridor);
    if (c !== undefined) {
      grid.cost[i] = Math.max(grid.known[i] ? (grid.cost[i] as number) : 0, c);
      grid.known[i] = 1;
    }
  }
  // A cell left unscored once the work is spent stays unknown and blocks; the search then
  // stops at its next step.
  const costOf = (i: number): number => {
    if (!grid.known[i]) {
      const c = score(cellCentre(grid, i), corridor + grid.cell / 2);
      if (c === undefined) {
        return Infinity;
      }
      grid.cost[i] = c;
      grid.known[i] = 1;
    }
    return grid.cost[i] as number;
  };
  const work = {
    add: (units: number) => {
      budget.work += units;
    },
    stopped: () => budget.work >= limit
  };
  const ends = endChecks(grid, leg, corridor, query);
  return yield* thetaStar(grid, leg.from, leg.to, costOf, work, ends);
}

/**
 * The start and goal cells are opened on their ends' own score, so a line
 * leaving or reaching them could cross a shoal elsewhere in the cell that
 * no score looked at. Within 1.5 cells of its end, past the end's cell
 * whatever corner of it the end lies in, each such line is checked as the
 * corridor it is. Where the water within that reach of an end is clear,
 * one query stands for all its lines.
 */
function endChecks(
  grid: Grid,
  leg: LegResult,
  corridor: number,
  query: (geom: Geom, bufferMetres?: number) => number | undefined
): EndCheck {
  const reach = 1.5 * grid.cell;
  const open = (c: number | undefined) => c !== undefined && c !== Infinity;
  const clear = new Map<"from" | "to", boolean>();
  const lines = { from: new Map<number, boolean>(), to: new Map<number, boolean>() };
  return (end, cell) => {
    const [at, other] = end === "from" ? [leg.from, leg.to] : [leg.to, leg.from];
    if (!clear.has(end)) {
      clear.set(end, open(query(footprintGeom([at]), reach + corridor)));
    }
    if (clear.get(end)) {
      return true;
    }
    const known = lines[end].get(cell);
    if (known !== undefined) {
      return known;
    }
    // Into the other end's cell, the line runs to that end itself.
    const to = cell === cellOf(grid, other) ? other : cellCentre(grid, cell);
    const [ax, ay] = grid.frame.toXY(at);
    const [bx, by] = grid.frame.toXY(to);
    const k = Math.min(1, reach / Math.max(Math.hypot(bx - ax, by - ay), 1e-9));
    const tip = grid.frame.toLonLat(ax + (bx - ax) * k, ay + (by - ay) * k);
    const c = query(footprintGeom(corridorRing(at, tip, corridor)));
    // Unchecked once the work is spent: blocked, and asked again should the search go on.
    if (c !== undefined) {
      lines[end].set(cell, c !== Infinity);
    }
    return open(c);
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
  // A cell is scored over the corridor around its centre plus half a cell. Cells much smaller
  // than the corridor would read the same water many times; at half the corridor or more, one
  // query reads about 25 cells' area at most.
  const cell = Math.max(opts.minCell, Math.max(w, h) / opts.maxCells, corridor / 2);
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

/** Perpendicular distance from p to the line a–b, metres, at route scale. */
function offLine(p: LonLat, a: LonLat, b: LonLat): number {
  const f = frameAt(a);
  const [px, py] = f.toXY(p);
  const [bx, by] = f.toXY(b);
  const len = Math.hypot(bx, by);
  return len === 0 ? Math.hypot(px, py) : Math.abs(px * by - py * bx) / len;
}

/**
 * The time the boat reaches the end of `points` leaving the first at `t`, ms;
 * truncated to the millisecond at every point, as the route check's ISO times are.
 */
function arrival(points: LonLat[], t: number, speed: number): number {
  for (let i = 1; i < points.length; i++) {
    t = Math.trunc(t + (haversine(points[i - 1] as LonLat, points[i] as LonLat) / speed) * 1000);
  }
  return t;
}

/**
 * Douglas–Peucker with a veto: a span becomes its chord when `passes`
 * accepts the chord, else it splits at the point farthest from the chord.
 * Each chord is checked from the time the boat reaches its start along the
 * path kept before it, leaving at `start` at `speed`, the times the final
 * check of the whole path uses. Simplification can therefore never make a
 * leg fail.
 */
export function simplify(
  points: LonLat[],
  passes: (pts: LonLat[], departure: number) => boolean,
  start = 0,
  speed = 1
): LonLat[] {
  function* check(pts: LonLat[], departure: number): Steps<boolean> {
    const ok = passes(pts, departure);
    yield;
    return ok;
  }
  return drain(simplifySteps(points, check, start, speed));
}

/** `simplify` whose `passes`, a route check, yields as it goes; it also yields after each. */
function simplifySteps(
  points: LonLat[],
  passes: (pts: LonLat[], departure: number) => Steps<boolean>,
  start: number,
  speed: number
): Steps<LonLat[]> {
  /** The kept points from `lo` to `hi`, the boat reaching `lo` at `t`. */
  function* keep(lo: number, hi: number, t: number): Steps<LonLat[]> {
    const a = points[lo] as LonLat;
    const b = points[hi] as LonLat;
    if (hi - lo < 2) {
      return [a, b];
    }
    const chord = yield* passes([a, b], t);
    yield;
    if (chord) {
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
    const head = yield* keep(lo, far, t);
    const tail = yield* keep(far, hi, arrival(head, t, speed));
    return [...head.slice(0, -1), ...tail];
  }
  return keep(0, points.length - 1, start);
}

/** Why a request searches no more legs, or undefined while it may. */
function notSearched(searched: number, used: number, opts: RepairOptions): string | undefined {
  if (searched >= opts.maxLegs) {
    return `not searched: at most ${opts.maxLegs} legs are repaired per request`;
  }
  return used >= opts.maxRequestWork ? REQUEST_LIMIT : undefined;
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
 * `maxLegs` of them, until the request's repairs have done `maxRequestWork`;
 * the rest get a reason. Every searched leg may do its full `maxWork`, so
 * its repair is the same as `repairLeg`'s whatever the legs before it. Each leg is checked at the time
 * the repairs before it bring the boat there, so a leg a detour makes late
 * is repaired or reported as it is then. `pause` runs after each searched
 * leg, every few hundred cells of a leg's search and after each of its
 * simplification checks, so a caller on the event loop can let other work in.
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
  let used = 0;
  let t = input.departure;
  for (let i = 0; i + 1 < input.coordinates.length; i++) {
    const { leg } = checkLeg(index, input, i, t);
    let repair: LegRepair | undefined;
    const failing = leg.status === "fail" || leg.status === "marginal";
    const skip = failing ? notSearched(searched, used, opts) : undefined;
    if (skip !== undefined) {
      repairs.push({ index: i, waypoints: [], legs: [], reason: skip });
    } else if (failing) {
      searched += 1;
      const steps = repairSteps(index, input, leg, opts);
      let r = steps.next();
      while (!r.done) {
        await pause();
        r = steps.next();
      }
      repair = r.value.repair;
      used += r.value.work;
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
