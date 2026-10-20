import type { LonLat } from "../foundation/geo";
import type { VesselModel } from "../model/vessel";
import type { ChartIndex } from "../spatial/chart-index";
import type { Motion, Scoring } from "./fan";
import { footprint } from "./fan";
import type { LookaheadOptions } from "./lookahead";
import type { Track } from "./trajectory";
import { escapeTrack } from "./trajectory";

/**
 * Seconds until P reaches warn or the footprint leaves chart coverage along
 * one track; Infinity when neither happens. Uncharted water is never clear.
 * The footprint at t = 0 is the same hull on every track, so it is skipped:
 * when it is risky every track would score 0.
 */
function trackTts(
  track: Track,
  times: number[],
  origin: LonLat,
  m: Motion,
  vessel: VesselModel,
  index: ChartIndex,
  s: Scoring,
  opts: LookaheadOptions
): number {
  for (const t of times) {
    if (t <= 0) {
      continue;
    }
    const fp = footprint(t, origin, [track], m, vessel, index, s, opts, true);
    if (fp.uncovered || fp.risk >= opts.thresholds.warn) {
      return t;
    }
  }
  return Infinity;
}

const TWO_PI = 2 * Math.PI;

/**
 * Escape fan (plan §4.8): headings every `escapeStep` out to ±`escapeMax`,
 * each reached by a turn at the boat's maximum rate. The heading with the
 * longest time to shoal wins; ties go to the smallest change. Null when no
 * heading does better than another, or none stays clear past the first
 * step: the current heading would then be published as the way out.
 */
export function escapeHeading(
  times: number[],
  origin: LonLat,
  m: Motion,
  vessel: VesselModel,
  index: ChartIndex,
  s: Scoring,
  opts: LookaheadOptions
): number | null {
  let best = { change: 0, tts: -Infinity };
  let worst = Infinity;
  const steps = Math.floor(opts.escapeMax / opts.escapeStep + 1e-9);
  for (let k = 0; k <= steps; k++) {
    for (const change of k === 0 ? [0] : [k * opts.escapeStep, -k * opts.escapeStep]) {
      const track = escapeTrack(m.cog, m.sog, change, opts.maxTurnRate);
      const tts = trackTts(track, times, origin, m, vessel, index, s, opts);
      if (tts > best.tts) {
        best = { change, tts };
      }
      worst = Math.min(worst, tts);
    }
    // Changes are tried smallest first, so the first heading clear over the
    // whole horizon cannot be beaten.
    if (best.tts === Infinity) {
      break;
    }
  }
  const first = times.find((t) => t > 0) ?? Infinity;
  if (best.tts <= first || (best.tts === worst && best.tts !== Infinity)) {
    return null;
  }
  return (((m.heading + best.change) % TWO_PI) + TWO_PI) % TWO_PI;
}
