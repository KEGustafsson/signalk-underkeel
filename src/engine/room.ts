/**
 * A leg's room (plan §4.11, pilotage): the widest buffer from `lo` up to `hi` its corridor lies
 * in swept or dredged water all through at. A corridor at a buffer holds the corridor at every
 * narrower one, so the buffers that pass end at one edge, found by halving to ROOM_STEP. Tiles
 * that reach past the sweep's edge do not pass, so it is never wider than the swept water.
 */

/** The resolution a leg's room is found to, metres. */
export const ROOM_STEP = 0.25;

/**
 * The room for the test `swept` (whether the corridor at a buffer lies in swept water), `lo`
 * taken to pass: `hi` when it passes too, else the widest passing buffer found by halving,
 * rounded down to a decimetre.
 */
export function* roomSteps(
  swept: (buffer: number) => Generator<void, boolean, void>,
  [lo, hi]: [number, number]
): Generator<void, number, void> {
  if (yield* swept(hi)) {
    return hi;
  }
  let [ok, bad] = [lo, hi];
  while (bad - ok > ROOM_STEP) {
    const mid = (ok + bad) / 2;
    if (yield* swept(mid)) {
      ok = mid;
    } else {
      bad = mid;
    }
  }
  return Math.floor(ok * 10) / 10;
}
