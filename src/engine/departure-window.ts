import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { WaterLevel } from "../model/uncertainty";
import type { ChartIndex } from "../spatial/chart-index";
import type { LegStatus, RouteCheckInput } from "./route-check";
import { checkLeg } from "./route-check";

/**
 * Departure window (plan §4.11): the route is re-checked for departures
 * every `step` over the horizon, and the intervals in which every leg is
 * `ok` are returned. Each leg takes the lowest level from its arrival until
 * one step after it leaves, so a sampled departure answers for every
 * departure up to the next one. A leg's result depends on the departure
 * only through its water level, so legs are re-checked only when that
 * level changes, and not at all after the departure's first failing leg.
 * Levels are rounded down to the centimetre and σ up, so the reuse is never
 * optimistic. A higher level never raises P (invariant 2), so with the same
 * σ a leg `ok` at one level is reused as `ok` at any higher one, and `fail`
 * at any lower one (plan §4.11).
 */

export interface WindowStep {
  departure: string;
  /** The worst leg status for this departure. */
  status: LegStatus;
}

export interface DepartureWindow {
  /** Departures from `from` to `to` (inclusive, ISO 8601) in which every leg is ok. */
  windows: { from: string; to: string }[];
  steps: WindowStep[];
  /** Leg checks run; the rest were reused. */
  checks: number;
}

const RANK: Record<LegStatus, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };

function rounded(wl: WaterLevel): WaterLevel {
  return {
    ...wl,
    h: Math.floor(wl.h * 100) / 100,
    sigma: Math.ceil(wl.sigma * 100) / 100
  };
}

/**
 * Reuse across levels only from this accept probability up. A query may
 * stop at a tile whose P bound is below RISK_STOP_BELOW (1e-4), so a direct
 * check can report P up to that much above the model's; from 1e-3 up both
 * the `ok` (P < probability) and `fail` (P ≥ probability) bounds lie above
 * it, and the reused status is the one a direct check would give.
 */
export const REUSE_MIN_PROBABILITY = 1e-3;

/** One leg's checked results at one σ and fallback reason. */
interface LegResults {
  at: Map<number, LegStatus>;
  /** Lowest level checked `ok`, highest checked `fail`. */
  okFrom: number;
  failTo: number;
}

class LegMemo {
  private readonly legs = new Map<string, LegResults>();

  constructor(private readonly acrossLevels: boolean) {}

  private results(i: number, wl: WaterLevel): LegResults {
    const key = `${i}|${wl.sigma}|${wl.degraded ?? ""}`;
    let r = this.legs.get(key);
    if (!r) {
      r = { at: new Map(), okFrom: Infinity, failTo: -Infinity };
      this.legs.set(key, r);
    }
    return r;
  }

  get(i: number, wl: WaterLevel): LegStatus | undefined {
    const r = this.results(i, wl);
    const exact = r.at.get(wl.h);
    if (exact !== undefined || !this.acrossLevels) {
      return exact;
    }
    return wl.h >= r.okFrom ? "ok" : wl.h <= r.failTo ? "fail" : undefined;
  }

  set(i: number, wl: WaterLevel, status: LegStatus): void {
    const r = this.results(i, wl);
    r.at.set(wl.h, status);
    if (status === "ok") {
      r.okFrom = Math.min(r.okFrom, wl.h);
    } else if (status === "fail") {
      r.failTo = Math.max(r.failTo, wl.h);
    }
  }
}

/** `pause` runs after each leg check and each departure so a caller on the event loop can let other work in. */
export async function departureWindow(
  index: ChartIndex,
  input: Omit<RouteCheckInput, "departure">,
  from: number,
  to: number,
  stepMs: number,
  pause: () => Promise<void> = () => Promise.resolve()
): Promise<DepartureWindow> {
  const memo = new LegMemo(input.probability >= REUSE_MIN_PROBABILITY);
  const steps: WindowStep[] = [];
  let checks = 0;
  const legs = input.coordinates.length - 1;
  for (let t = from; t <= to; t += stepMs) {
    let start = t;
    let worst: LegStatus = "ok";
    // `fail` ranks highest, so the legs after one cannot change the departure's status.
    for (let i = 0; i < legs && worst !== "fail"; i++) {
      const a = input.coordinates[i] as LonLat;
      const b = input.coordinates[i + 1] as LonLat;
      const end = start + (haversine(a, b) / (input.speeds[i] as number)) * 1000;
      const wl = rounded(input.waterLevel(start, end + stepMs, [a, b]));
      let status = memo.get(i, wl);
      if (status === undefined) {
        checks += 1;
        const fixed = { ...input, departure: t, waterLevel: () => wl };
        status = checkLeg(index, fixed, i, start).leg.status;
        memo.set(i, wl, status);
        await pause();
      }
      if (RANK[status] > RANK[worst]) {
        worst = status;
      }
      start = end;
    }
    steps.push({ departure: new Date(t).toISOString(), status: worst });
    await pause();
  }
  return { windows: windowsOf(steps), steps, checks };
}

function windowsOf(steps: WindowStep[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let open: { from: string; to: string } | undefined;
  for (const s of steps) {
    if (s.status === "ok") {
      open = open ? { ...open, to: s.departure } : { from: s.departure, to: s.departure };
    } else if (open) {
      out.push(open);
      open = undefined;
    }
  }
  if (open) {
    out.push(open);
  }
  return out;
}
