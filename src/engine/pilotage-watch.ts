import type { LonLat } from "../foundation/geo";

/**
 * Pilotage underway (plan §4.11): the plan's tolerance held to the live fix. A plan is checked at
 * the planning σ (`model/fix-history.ts`), never at the fix of the moment; each leg in swept water
 * has its room, the widest buffer its corridor stays in swept water at (`route-check.ts`). On
 * such a leg of the active route, kp · σ of the live fix wider than its room means the fix cannot
 * tell whether the boat is still in the swept water: a warning to steer by the marks and slow
 * down. Advisory only: nothing is steered (invariant 7).
 */

/** A leg of the active route and its room, metres: undefined where none is known. */
export interface WatchedLeg {
  from: LonLat;
  to: LonLat;
  room?: number;
}

/** A boat this far from every leg is not following the route, metres. */
export const ON_ROUTE = 50;

const RAD = Math.PI / 180;
const R = 6_371_008.8;

/** Distance from `p` to the segment a–b and where along it its foot lies (0–1), in a plane at p. */
export function offset(p: LonLat, a: LonLat, b: LonLat): { d: number; t: number } {
  const k = Math.cos(p[1] * RAD) * R * RAD;
  const ax = (a[0] - p[0]) * k;
  const ay = (a[1] - p[1]) * R * RAD;
  const dx = (b[0] - a[0]) * k;
  const dy = (b[1] - a[1]) * R * RAD;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
  return { d: Math.hypot(ax + dx * t, ay + dy * t), t };
}

/** The leg `p` is on: the nearest within ON_ROUTE metres, or none. */
export function legAt(
  p: LonLat,
  legs: readonly Pick<WatchedLeg, "from" | "to">[]
): number | undefined {
  let best: number | undefined;
  let bestD = ON_ROUTE;
  legs.forEach((l, i) => {
    const { d } = offset(p, l.from, l.to);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export interface PilotageVerdict {
  state: "normal" | "warn";
  message: string;
  data: { leg: number; room: number; need: number | null };
}

/**
 * The verdict on leg `i` with room `room` for the live buffer `need` (kp · σ of the fix), or
 * undefined (no fix at all, or integrity failing) when nothing measures the boat's position.
 */
export function pilotageVerdict(
  i: number,
  room: number,
  need: number | undefined
): PilotageVerdict {
  const leg = i + 1;
  if (need === undefined) {
    return {
      state: "warn",
      message: `Pilotage: route leg ${leg} is swept water ±${room.toFixed(1)} m wide either side, and the position fix cannot be trusted: steer by the marks`,
      data: { leg, room, need: null }
    };
  }
  if (need > room) {
    return {
      state: "warn",
      message: `Pilotage: the position fix (±${need.toFixed(1)} m) is wider than the swept water on route leg ${leg} (±${room.toFixed(1)} m): steer by the marks and slow down`,
      data: { leg, room, need }
    };
  }
  return {
    state: "normal",
    message: `Pilotage: the position fix (±${need.toFixed(1)} m) holds within the swept water on route leg ${leg} (±${room.toFixed(1)} m)`,
    data: { leg, room, need }
  };
}
