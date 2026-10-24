/**
 * Repair work is counted, never timed, so a request gives the same answer
 * on any machine (plan §4.11).
 */

/** Fixed cost of one minDepthOver call, in tiles examined (laptop: about 12 µs plus 0.3–0.6 µs per tile). */
export const QUERY_WORK = 32;

/** Theta* line-of-sight samples per work unit (one sample about 60–90 ns). */
export const LINE_SAMPLES_PER_UNIT = 5;

export function queryWork(r: { visits: number }): number {
  return r.visits + QUERY_WORK;
}
