import { BOX_REACH } from "./spatial/build-items";

/**
 * The radius of the chart box around the vessel (plan §4.2). A box must let the vessel run,
 * from its centre, the distance it covers while the next box is built (with the refresh
 * margin) plus the look-ahead's reach and the no-coverage band inside the edge; otherwise
 * rebuilds run back to back and a slow machine at speed lets the vessel reach the edge. The
 * box grows for that from the configured radius up to a cap, and shrinks back only once the
 * speed needs much less, so the radius does not change with every gust.
 */

/** Radii are chosen in steps of this many km. */
export const STEP_KM = 0.5;
/** A new box is sized for this much more than the current speed. */
export const SPEED_HEADROOM = 1.25;
/** A box is kept at its size while the size the speed needs is above this share of it. */
export const SHRINK_BELOW = 0.7;
/** The automatic cap: this radius on a 256 MB build heap, growing with the heap's root. */
const CAP_AT_256_MB_KM = 10;
/** The largest box the configuration allows, km. */
export const MAX_BOX_KM = 50;

/**
 * The automatic cap for a build heap of `heapMb`: 10 km at 256 MB (a 1 GB Pi 3 or Cerbo GX),
 * 20 km at 1 GB, 28 km at 2 GB, rounded down to STEP_KM. The heap is a quarter of the RAM the
 * system reports, which on a 4 GB Pi 4 is about 3.8 GiB: 19 km. A build's memory grows with the box's area,
 * and the 10 km box with the ENC pair at leaf zoom 20 builds in under 96 MB.
 */
export function autoCapKm(heapMb: number): number {
  const km = CAP_AT_256_MB_KM * Math.sqrt(heapMb / 256);
  return Math.min(MAX_BOX_KM, Math.floor(km / STEP_KM) * STEP_KM);
}

export interface SizingInput {
  /** Speed over ground, m/s; 0 when stopped or unknown. */
  sog: number;
  /** Duration of the last box build, ms, and the radius it was built at, km. */
  buildMs: number;
  builtKm: number;
  /** Look-ahead reach plus the no-coverage band inside the box edge, metres. */
  reachM: number;
  /** Refreshes start this many build durations before the edge comes in reach. */
  margin: number;
  /** The configured radius and the cap, km. */
  minKm: number;
  capKm: number;
}

export interface BoxSize {
  /** Radius for the next box, km. */
  radiusKm: number;
  /** Whether a box of `radiusKm` is large enough at the current speed. */
  enough: boolean;
  /**
   * When it is not: the smallest radius that would be, past the cap; undefined when no radius
   * up to MAX_BOX_KM would, the build time growing with the box faster than the box does.
   */
  neededKm?: number;
}

/**
 * The build time of a box of `km`: the measured one, grown with the build area past the
 * radius it was measured at. Tiles are built to BOX_REACH past the box, so the area grows
 * with (radius + reach)². Never shorter than measured, so a smaller box is not assumed to
 * build faster until it has.
 */
export function buildMsAt(km: number, i: Pick<SizingInput, "buildMs" | "builtKm">): number {
  const reach = BOX_REACH / 1000;
  return i.buildMs * Math.max(1, ((km + reach) / (i.builtKm + reach)) ** 2);
}

/** Whether a box of `km` holds a refresh's run at `sog` plus the reach between its centre and edge. */
export function fits(km: number, i: SizingInput, sog = i.sog): boolean {
  return km * 1000 >= (i.margin * sog * buildMsAt(km, i)) / 1000 + i.reachM;
}

/** The smallest radius on the STEP_KM grid in [from, to] that fits at `sog`. */
function smallestFit(from: number, to: number, i: SizingInput, sog: number): number | undefined {
  for (let km = from; km <= to + 1e-9; km = nextStep(km)) {
    if (fits(km, i, sog)) {
      return km;
    }
  }
  return undefined;
}

const nextStep = (km: number): number => (Math.floor(km / STEP_KM + 1e-9) + 1) * STEP_KM;

/** The radius at which the box's spare reach is greatest, when none fits. */
function roomiest(i: SizingInput): number {
  let best = i.minKm;
  const spare = (km: number) => km * 1000 - (i.margin * i.sog * buildMsAt(km, i)) / 1000;
  for (let km = i.minKm; km <= i.capKm + 1e-9; km = nextStep(km)) {
    if (spare(km) > spare(best)) {
      best = km;
    }
  }
  return best;
}

/**
 * The radius for the next box, given the radius of the box in use. Stopped or without a
 * speed the box in use keeps its size, within the configured radius and the cap.
 */
export function nextSize(i: SizingInput, currentKm?: number): BoxSize {
  const minKm = Math.min(i.minKm, i.capKm);
  const within = currentKm !== undefined && currentKm >= minKm && currentKm <= i.capKm;
  if (!(i.sog > 0)) {
    return { radiusKm: within ? currentKm : minKm, enough: true };
  }
  const want = smallestFit(minKm, i.capKm, i, i.sog * SPEED_HEADROOM);
  if (want === undefined) {
    const radiusKm = smallestFit(minKm, i.capKm, i, i.sog) ?? roomiest(i);
    const enough = fits(radiusKm, i);
    const neededKm = enough ? undefined : smallestFit(i.capKm, MAX_BOX_KM, i, i.sog);
    return { radiusKm, enough, ...(neededKm === undefined ? {} : { neededKm }) };
  }
  // Kept while it holds the speed and the speed does not need much less.
  if (within && fits(currentKm, i) && want <= currentKm && want > SHRINK_BELOW * currentKm) {
    return { radiusKm: currentKm, enough: true };
  }
  return { radiusKm: want, enough: true };
}
