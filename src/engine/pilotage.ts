import type { LonLat } from "../foundation/geo";
import type { IntegrityResult } from "../model/integrity";
import type { ChartIndex } from "../spatial/chart-index";
import type { FootprintVerdict, RouteCheckInput } from "./route-check";
import { checkFootprint } from "./route-check";

/**
 * Pilotage (plan §4.11): a leg in water a sweep or dredging covers, its edges marked, is checked
 * at the boat's own position buffer, kp · σ of its fix as the integrity monitor measures it, in
 * place of the least position buffer the look-ahead holds open water to. The leg's corridor at
 * that buffer must lie in swept or dredged water all through (`QueryOptions.sweptOnly`); else the
 * leg is checked at the least buffer as any other (`route-check.ts`).
 */

/** The narrowest buffer pilotage gives, metres: half a small boat's beam and a margin. */
export const PILOT_MIN_BUFFER = 2;

/**
 * The pilotage buffer, metres, while the fix is good and measured: none when integrity fails or
 * has no σ, or when it is not narrower than the least buffer.
 */
export function pilotBuffer(
  integrity: IntegrityResult | undefined,
  kp: number,
  least: number
): number | undefined {
  if (!integrity?.ok || !Number.isFinite(integrity.sigmaPos) || integrity.sigmaPos <= 0) {
    return undefined;
  }
  const buffer = Math.max(PILOT_MIN_BUFFER, kp * integrity.sigmaPos);
  return buffer < least ? buffer : undefined;
}

/**
 * A box's footprint scored as the planning API's `box` scores it: `narrow`, the box at the
 * pilotage buffer, flagged PILOTAGE, when it lies in swept or dredged water all through; else
 * `ring`, the box at the planning buffer.
 */
export function pilotedBox(
  index: ChartIndex,
  input: RouteCheckInput,
  rings: { ring: LonLat[]; narrow: LonLat[] | undefined },
  speed: number,
  window: { start: number; end: number }
): FootprintVerdict {
  let work = 0;
  if (rings.narrow) {
    const at = { ...window, at: rings.narrow };
    const v = checkFootprint(index, input, rings.narrow, speed, at, true);
    if (!v.unswept) {
      return { ...v, flags: [...v.flags, "PILOTAGE"] };
    }
    work = v.work;
  }
  const v = checkFootprint(index, input, rings.ring, speed, { ...window, at: rings.ring });
  return { ...v, work: work + v.work };
}
