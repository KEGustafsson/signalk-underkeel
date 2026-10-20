import type { LonLat } from "../foundation/geo";
import { sigmaExtra, thresholdDepth } from "../model/uncertainty";
import { vesselTerms } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import { footprintGeom, minDepthOver } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { LegResult, RouteCheckInput, Steps } from "./route-check";
import { checkLeg, checkRoute, checkRouteYielding, drain, UNCHECKED } from "./route-check";
import type { Grid } from "./route-repair-search";
import { frameAt, thetaStar } from "./route-repair-search";

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

export function repairLeg(
  index: ChartIndex,
  input: RouteCheckInput,
  leg: LegResult,
  opts: RepairOptions = DEFAULT_REPAIR
): LegRepair {
  return drain(repairSteps(index, input, leg, opts));
}

/** `repairLeg` split at every few hundred searched cells and after each simplification check. */
function* repairSteps(
  index: ChartIndex,
  input: RouteCheckInput,
  leg: LegResult,
  opts: RepairOptions
): Steps<LegRepair> {
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
      const r = minDepthOver(index.pyramid, at, {
        bufferMetres: corridor + grid.cell / 2,
        chartReachK: DEFAULT_BUILD.k,
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
  const path = yield* thetaStar(grid, leg.from, leg.to, costOf);
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
  const points = yield* simplifySteps(path, (pts) => check(pts).every((l) => l.status === "ok"));
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
  return drain(simplifySteps(points, passes));
}

/** `simplify` that yields after each call of `passes`, a route check. */
function simplifySteps(points: LonLat[], passes: (pts: LonLat[]) => boolean): Steps<LonLat[]> {
  function* keep(lo: number, hi: number): Steps<LonLat[]> {
    const a = points[lo] as LonLat;
    const b = points[hi] as LonLat;
    if (hi - lo < 2) {
      return [a, b];
    }
    const chord = passes([a, b]);
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
    const head = yield* keep(lo, far);
    return [...head.slice(0, -1), ...(yield* keep(far, hi))];
  }
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
      const steps = repairSteps(index, input, leg, opts);
      let r = steps.next();
      while (!r.done) {
        await pause();
        r = steps.next();
      }
      repair = r.value;
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
