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
 * optimistic.
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

/** `pause` runs after each leg check and each departure so a caller on the event loop can let other work in. */
export async function departureWindow(
  index: ChartIndex,
  input: Omit<RouteCheckInput, "departure">,
  from: number,
  to: number,
  stepMs: number,
  pause: () => Promise<void> = () => Promise.resolve()
): Promise<DepartureWindow> {
  const memo = new Map<string, LegStatus>();
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
      const key = `${i}|${wl.h}|${wl.sigma}|${wl.degraded ?? ""}`;
      let status = memo.get(key);
      if (status === undefined) {
        checks += 1;
        const fixed = { ...input, departure: t, waterLevel: () => wl };
        status = checkLeg(index, fixed, i, start).leg.status;
        memo.set(key, status);
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
