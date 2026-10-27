import fc from "fast-check";
import type { SizingInput } from "../src/box-sizing";
import {
  autoCapKm,
  buildMsAt,
  fits,
  MAX_BOX_KM,
  nextSize,
  SPEED_HEADROOM,
  STEP_KM
} from "../src/box-sizing";

/**
 * The chart box radius from speed and measured build time: large enough that the vessel
 * cannot reach the edge, less the look-ahead and the no-coverage band, before the next box
 * is built; between the configured radius and the cap; and not changed by small speed changes.
 */

const KN = 1852 / 3600;
/** The look-ahead's 0.3 NM plus the 2.36 km band inside the edge. */
const REACH = 556 + 2360;

const input = (over: Partial<SizingInput> = {}): SizingInput => ({
  sog: 0,
  buildMs: 300_000,
  builtKm: 10,
  reachM: REACH,
  margin: 1.5,
  minKm: 10,
  capKm: 25,
  ...over
});

/** A 3 km box that builds in a minute: at 20 kn the reach, not the build, sets its size. */
const SMALL = input({ minKm: 3, builtKm: 3, buildMs: 60_000, sog: 20 * KN, reachM: 617 + 2360 });

describe("box radius from speed and build time", () => {
  test("stopped or without a speed the box keeps its size, within the radius and the cap", () => {
    expect(nextSize(input(), 14)).toEqual({ radiusKm: 14, enough: true });
    expect(nextSize(input(), 30)).toEqual({ radiusKm: 10, enough: true });
    expect(nextSize(input())).toEqual({ radiusKm: 10, enough: true });
  });

  test("a 10 km box with 5-minute builds holds 15 kn and stays 10 km", () => {
    expect(nextSize(input({ sog: 15 * KN }))).toEqual({ radiusKm: 10, enough: true });
  });

  test("a small box grows to the smallest step that holds the speed with headroom", () => {
    const s = nextSize(SMALL);
    expect(s.enough).toBe(true);
    expect(s.radiusKm).toBe(6);
    expect(fits(s.radiusKm, SMALL, SMALL.sog * SPEED_HEADROOM)).toBe(true);
    expect(fits(s.radiusKm - STEP_KM, SMALL, SMALL.sog * SPEED_HEADROOM)).toBe(false);
    // The build time it is planned on grows with the build area.
    expect(buildMsAt(s.radiusKm, SMALL)).toBeGreaterThan(SMALL.buildMs);
  });

  test("under the cap the status gets the radius that would do", () => {
    const capped = { ...SMALL, capKm: 4 };
    const s = nextSize(capped);
    expect(s.enough).toBe(false);
    expect(s.radiusKm).toBeLessThanOrEqual(4);
    expect(s.neededKm).toBe(5);
    expect(fits(s.neededKm as number, capped)).toBe(true);
  });

  test("at 15 kn with 12-minute builds of a 10 km box no size keeps up", () => {
    // Running 1.5 × 12 min at 15 kn is 8.3 km, plus 2.9 km of reach: over 10 km, and a larger
    // box builds longer by more than it adds.
    const s = nextSize(input({ sog: 15 * KN, buildMs: 720_000 }));
    expect(s).toEqual({ radiusKm: 10, enough: false });
  });

  test("hysteresis: a grown box is kept while the speed needs over 70% of it", () => {
    const grown = nextSize(SMALL).radiusKm;
    expect(nextSize({ ...SMALL, sog: SMALL.sog * 0.9 }, grown).radiusKm).toBe(grown);
    const slow = nextSize({ ...SMALL, sog: 5 * KN }, grown);
    expect(slow.radiusKm).toBeLessThan(0.7 * grown);
    expect(slow.radiusKm).toBeGreaterThanOrEqual(3);
  });

  test("the radius stays between the configured radius and the cap, and is enough when it says so", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.integer({ min: 10_000, max: 1_200_000 }),
        fc.integer({ min: 2, max: 25 }),
        fc.integer({ min: 0, max: 30 }),
        fc.option(fc.integer({ min: 2, max: 50 }), { nil: undefined }),
        (sog, buildMs, minKm, extra, current) => {
          const i = input({ sog, buildMs, builtKm: minKm, minKm, capKm: minKm + extra });
          const s = nextSize(i, current);
          return (
            s.radiusKm >= minKm &&
            s.radiusKm <= i.capKm &&
            // Stopped, only the vessel's own footprint is read: no speed makes a box too small.
            (i.sog > 0 ? s.enough === fits(s.radiusKm, i) : s.enough) &&
            (s.neededKm === undefined || (s.neededKm > i.capKm && s.neededKm <= MAX_BOX_KM))
          );
        }
      ),
      { numRuns: 1000 }
    );
  });

  test("the automatic cap follows the build heap: 10 km at 256 MB, 20 km at 1 GB", () => {
    expect([256, 512, 1024, 2048, 1 << 20].map(autoCapKm)).toEqual([10, 14, 20, 28, 50]);
  });
});
