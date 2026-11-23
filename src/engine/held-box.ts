import type { LonLat } from "../foundation/geo";
import type { ChartIndex } from "../spatial/chart-index";
import type { FootprintVerdict, RouteCheckInput } from "./route-check";
import { checkFootprint, checkStripFootprint, FAIRWAY_GAP_FLAG } from "./route-check";

/**
 * A planning session's box (plan §4.11): its footprint `ring`, the box grown by the cross-track
 * limit and the hull's half-beam, read three ways where they apply, the lowest risk standing, as
 * a leg's corridor is (`route-check.ts`, `heldSteps`): through the index; in swept or dredged
 * water all through (`QueryOptions.sweptOnly`), when the footprint touches any; and held to a
 * fairway gap strip when it lies inside one, flagged FAIRWAY_GAP (`gap-strips.ts`). Which
 * readings apply follows from the footprint alone, never the draft (invariant 2).
 */
export function heldBox(
  index: ChartIndex,
  input: RouteCheckInput,
  ring: LonLat[],
  speed: number,
  window: { start: number; end: number }
): FootprintVerdict {
  const at = { ...window, at: ring };
  const v = checkFootprint(index, input, ring, speed, at);
  let best = v;
  let work = v.work;
  if (v.flags.includes("SWEPT") || v.flags.includes("DREDGED")) {
    const swept = checkFootprint(index, input, ring, speed, at, true);
    work += swept.work;
    if (!swept.unswept && swept.risk < best.risk) {
      best = swept;
    }
  }
  const held = checkStripFootprint(index, input, ring, speed, at);
  if (held) {
    work += held.work;
    if (!held.unswept && held.risk < best.risk) {
      best = { ...held, flags: [...held.flags, FAIRWAY_GAP_FLAG] };
    }
  }
  return { ...best, work };
}
