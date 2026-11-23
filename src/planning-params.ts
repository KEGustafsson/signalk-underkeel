import { LIMITS } from "./api/route-request";
import type { SessionParams } from "./planning-api";

/** What a planning session may be started with (`planning-api.ts`). */

const within = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Why `p` cannot start a session, or undefined: the same bounds `/route-check`
 * holds a request to, applied to the values the session would score with.
 */
export function paramsError(
  p: SessionParams,
  probability: number,
  xteLimit: number
): string | undefined {
  if (!Number.isFinite(p.departure) || !Number.isFinite(p.until) || p.until < p.departure) {
    return "departure and until must be finite epoch ms, until not before departure";
  }
  if (!within(p.speed, LIMITS.minSpeed, LIMITS.maxSpeed)) {
    return `speed must be ${LIMITS.minSpeed}..${LIMITS.maxSpeed} m/s`;
  }
  if (!within(xteLimit, 0, LIMITS.maxXte)) {
    return `xteLimit must be 0..${LIMITS.maxXte} m`;
  }
  if (!within(probability, LIMITS.minProbability, LIMITS.maxProbability)) {
    return `probability must be ${LIMITS.minProbability}..${LIMITS.maxProbability}`;
  }
  if (p.draft !== undefined && !within(p.draft, LIMITS.minDraft, LIMITS.maxDraft)) {
    return `draft must be ${LIMITS.minDraft}..${LIMITS.maxDraft} m`;
  }
  if (p.airHeight !== undefined && !within(p.airHeight, LIMITS.minAirHeight, LIMITS.maxAirHeight)) {
    return `airHeight must be ${LIMITS.minAirHeight}..${LIMITS.maxAirHeight} m`;
  }
  if (p.waveHeight !== undefined && !within(p.waveHeight, 0, LIMITS.maxWaveHeight)) {
    return `waveHeight must be 0..${LIMITS.maxWaveHeight} m`;
  }
  return undefined;
}
