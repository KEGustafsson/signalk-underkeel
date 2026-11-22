import type { LonLat } from "../foundation/geo";
import type { ChartIndex } from "../spatial/chart-index";
import type { DepthResult } from "../spatial/pyramid";
import { footprintGeom, minDepthOver } from "../spatial/pyramid";
import { alongRhumb, corridorRing, greatCircleOffset, legCorridors } from "./corridor";
import { heldDepth, stripSpans } from "./gap-strips";
import type { Steps } from "./route-check";
import { queryWork } from "./work";

/**
 * A leg's corridor read from the index, piece by piece (`corridor.ts`), as the route check scores
 * it (`route-check.ts`), and through the fairway gap strips under pilotage (`gap-strips.ts`).
 */

export interface LegDepth {
  result: DepthResult;
  ring: LonLat[];
  /** Work its corridor queries did (work.ts). */
  work: number;
}

/** Depths deeper than the UKC-zero depth plus this are reported as a lower bound. */
export const CLEARANCE_RESOLUTION = 5;

export interface Scoring {
  threshold: number;
  sigmaExtra: number;
}

export function* corridorSteps(
  index: ChartIndex,
  a: LonLat,
  b: LonLat,
  r: number,
  s: Scoring,
  sweptOnly = false
): Steps<LegDepth> {
  let unswept = false;
  let best: Omit<LegDepth, "work"> | undefined;
  let flags = 0;
  let covered = Infinity;
  let work = 0;
  const cells = new Set<number>();
  for (const ring of legCorridors(a, b, r)) {
    const result = minDepthOver(index.pyramid, footprintGeom(ring), {
      chartPosition: true,
      clearAbove: s.threshold + CLEARANCE_RESOLUTION,
      risk: { threshold: s.threshold, sigmaExtra: s.sigmaExtra },
      sweptOnly
    });
    work += queryWork(result);
    unswept ||= result.unswept === true;
    flags |= result.flags;
    covered = Math.min(covered, result.coveredDMin);
    result.cellRefs.forEach((c) => cells.add(c));
    if (best === undefined || result.maxRisk > best.result.maxRisk) {
      best = { result, ring };
    }
    yield;
  }
  const leg = best as Omit<LegDepth, "work">;
  return {
    ...leg,
    work,
    result: {
      ...leg.result,
      flags,
      coveredDMin: covered,
      cellRefs: [...cells],
      ...(sweptOnly && { unswept })
    }
  };
}

/**
 * A leg's corridor `r` metres each side held to the fairway gap strips it passes through
 * (`gap-strips.ts`): each stretch whose corridor lies inside a strip at the strip's depth, the
 * stretches between through the index, swept or dredged all through. Their corridors together
 * hold the leg's, each stretch's reaching `r` past its ends. Undefined when the leg passes
 * through no strip.
 */
export function* bridgedSteps(
  index: ChartIndex,
  from: LonLat,
  to: LonLat,
  r: number,
  s: Scoring
): Steps<LegDepth | undefined> {
  const spans = stripSpans(index, from, to, r);
  if (spans.length === 0) {
    return undefined;
  }
  const at = (t: number): LonLat => alongRhumb(from, to, t);
  // A stretch's own great circle is not the leg's: widened by how far the leg's strays.
  const wide = r + greatCircleOffset(from, to);
  const parts: LegDepth[] = [];
  let done = 0;
  for (const span of [...spans, undefined]) {
    const end = span?.from ?? 1;
    if (end > done) {
      const d = yield* corridorSteps(index, at(done), at(end), wide, s, true);
      parts.push(d);
      if (d.result.unswept !== false) {
        return mergedDepth(parts);
      }
    }
    if (span) {
      const ring = corridorRing(at(span.from), at(span.to), wide);
      parts.push({ ...heldDepth(index, ring, span, s), ring });
      yield;
      done = span.to;
    }
  }
  return mergedDepth(parts);
}

/** The parts of one corridor as one: the riskiest part's result, with every part's flags and cells. */
function mergedDepth(parts: LegDepth[]): LegDepth {
  let best = parts[0] as LegDepth;
  let flags = 0;
  let covered = Infinity;
  let work = 0;
  let unswept = false;
  const cells = new Set<number>();
  for (const p of parts) {
    flags |= p.result.flags;
    covered = Math.min(covered, p.result.coveredDMin);
    work += p.work;
    unswept ||= p.result.unswept !== false;
    p.result.cellRefs.forEach((c) => cells.add(c));
    if (p.result.maxRisk > best.result.maxRisk) {
      best = p;
    }
  }
  return {
    ring: best.ring,
    work,
    result: { ...best.result, flags, coveredDMin: covered, cellRefs: [...cells], unswept }
  };
}
