import type { LonLat } from "../foundation/geo";
import type { VesselModel } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import type { Motion, Scoring } from "./fan";
import { footprint, spanOf } from "./fan";
import type { LookaheadOptions } from "./lookahead";
import type { Track } from "./trajectory";
import { escapeMembers } from "./trajectory";

/**
 * Seconds until P reaches warn or the footprint leaves chart coverage along
 * one heading's fan of tracks; Infinity when neither happens. Uncharted
 * water is never clear.
 * A walk may stop at certain land, which is P ≥ warn whatever its coverage.
 * The footprint at t = 0 is the same hull on every heading, so it is skipped:
 * when it is risky every heading would score 0.
 */
function headingTts(
  tracks: Track[],
  times: number[],
  step: number,
  origin: LonLat,
  m: Motion,
  vessel: VesselModel,
  index: ChartIndex,
  s: Scoring,
  opts: LookaheadOptions
): number {
  for (let i = 0; i < times.length; i++) {
    const t = times[i] as number;
    if (t <= 0) {
      continue;
    }
    const span = spanOf(times[i - 1], step);
    const fp = footprint(t, origin, tracks, m, vessel, index, s, opts, true, span);
    if (fp.uncovered || fp.risk >= opts.thresholds.warn) {
      return t;
    }
  }
  return Infinity;
}

const TWO_PI = 2 * Math.PI;

/**
 * Escape fan (plan §4.8): headings every `escapeStep` out to ±`escapeMax`,
 * each reached by a turn at the boat's maximum rate and scored with the
 * fan's COG and ROT spread, as the state is. The heading with the longest
 * time to shoal wins; ties go to the smallest change. Null when no
 * heading does better than holding course, which needs no dodge, or none
 * stays clear past the first step: the current heading would then be
 * published as the way out.
 */
export function escapeHeading(
  times: number[],
  step: number,
  origin: LonLat,
  m: Motion,
  vessel: VesselModel,
  index: ChartIndex,
  s: Scoring,
  opts: LookaheadOptions
): number | null {
  let best = { change: 0, tts: -Infinity };
  const steps = Math.floor(opts.escapeMax / opts.escapeStep + 1e-9);
  for (let k = 0; k <= steps; k++) {
    for (const change of k === 0 ? [0] : [k * opts.escapeStep, -k * opts.escapeStep]) {
      const tracks = escapeMembers(
        m.cog,
        m.sog,
        change,
        opts.maxTurnRate,
        { cog: opts.sigmaCog, rot: opts.sigmaRot },
        opts.turnFor,
        m.age
      );
      const tts = headingTts(tracks, times, step, origin, m, vessel, index, s, opts);
      if (tts > best.tts) {
        best = { change, tts };
      }
    }
    // Changes are tried smallest first, so the first heading clear over the
    // whole horizon cannot be beaten.
    if (best.tts === Infinity) {
      break;
    }
  }
  const first = times.find((t) => t > 0) ?? Infinity;
  if (best.change === 0 || best.tts <= first) {
    return null;
  }
  return (((m.heading + best.change) % TWO_PI) + TWO_PI) % TWO_PI;
}
