import type { LonLat } from "../foundation/geo";
import type { ChartIndex } from "../spatial/chart-index";
import type { FootprintVerdict, RouteCheckInput } from "./route-check";
import { checkFootprint, checkStripFootprint, drain, sweptAt } from "./route-check";
import { roomSteps } from "./room";

/**
 * Pilotage (plan §4.11): a leg in water a sweep or dredging covers, its edges marked, is checked
 * at the boat's planned position buffer, kp · the planning σ (`model/fix-history.ts`: the
 * configured σ, or what the boat's fix has shown over days when that is wider), in place of the
 * least position buffer the look-ahead holds open water to. The leg's corridor at that buffer
 * must lie in swept or dredged water all through (`QueryOptions.sweptOnly`), or inside a fairway
 * gap strip where it is not (`gap-strips.ts`); else the leg is checked at the least buffer as any
 * other (`route-check.ts`). A plan never reads the live fix: the same request gives the same
 * route whatever the HDOP at the berth. The route check gives each piloted leg its room, the
 * widest buffer it still passes so at, and the live fix is held to that room underway
 * (`pilotage-watch.ts`).
 */

/** The narrowest buffer pilotage gives, metres: half a small boat's beam and a margin. */
export const PILOT_MIN_BUFFER = 2;

/**
 * The pilotage buffer a plan is checked at, metres: kp · `sigma`, the planning σ, at least
 * PILOT_MIN_BUFFER; none when it is not narrower than the least buffer.
 */
export function plannedPilotBuffer(sigma: number, kp: number, least: number): number | undefined {
  if (!Number.isFinite(sigma) || sigma <= 0) {
    return undefined;
  }
  const buffer = Math.max(PILOT_MIN_BUFFER, kp * sigma);
  return buffer < least ? buffer : undefined;
}

/**
 * A box's footprint scored as the planning API's `box` scores it: `narrow`, the box at the
 * pilotage buffer, flagged PILOTAGE, when it lies in swept or dredged water all through, or
 * inside one fairway gap strip at the strip's depth; else `ring`, the box at the planning buffer.
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
    const held = checkStripFootprint(index, input, rings.narrow, speed, at);
    if (held) {
      work += held.work;
      if (!held.unswept) {
        return { ...held, work, flags: [...held.flags, "PILOTAGE"] };
      }
    }
  }
  const v = checkFootprint(index, input, rings.ring, speed, { ...window, at: rings.ring });
  return { ...v, work: work + v.work };
}

/**
 * The room of the leg `ends` at cross-track `xte`, from `range[0]` up to `range[1]`
 * (`room.ts`): undefined when not even the narrowest corridor lies in swept water.
 */
export function roomOf(
  index: ChartIndex,
  ends: [LonLat, LonLat],
  xte: number,
  range: [number, number]
): number | undefined {
  const test = sweptAt(index, ends, xte);
  return drain(test(range[0])) ? drain(roomSteps(test, range)) : undefined;
}
