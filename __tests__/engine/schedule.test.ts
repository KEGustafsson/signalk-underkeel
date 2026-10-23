import type { FootprintResult } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import { MAX_FOOTPRINTS, scheduleFor, scoreSchedule, stepFor } from "../../src/engine/schedule";

describe("scheduleFor", () => {
  const vessel = { draft: 2, length: 12, beam: 4 };
  const motion = (sog: number, horizon: number) => ({
    known: true,
    moving: true,
    cog: 0,
    sog,
    rot: 0,
    heading: 0,
    horizon
  });

  test("the plan step holds out to the warn window at any horizon; beyond it footprints touch", () => {
    const opts = { ...DEFAULT_LOOKAHEAD, distance: 5 * 1852 };
    const reach = vessel.length + 2 * opts.positionBuffer;
    for (const sog of [0.26, 0.3, 0.5, 1, 3, 7, 20]) {
      const horizon = Math.max(opts.minHorizon, opts.distance / sog);
      const { times, step } = scheduleFor(motion(sog, horizon), vessel, opts);
      // A 5 NM horizon at 0.3 m/s once stretched every step to 77 s, alarm window included.
      expect(step).toBe(stepFor(sog, vessel, opts));
      const within = times.filter((t) => t <= opts.warnWithin);
      expect(within).toEqual(
        Array.from({ length: Math.floor(opts.warnWithin / step + 1e-9) + 1 }, (_, i) => i * step)
      );
      expect(times.length).toBeLessThanOrEqual(MAX_FOOTPRINTS);
      expect(times.at(-1)).toBeCloseTo(horizon, 9);
      times.slice(1).forEach((t, i) => {
        expect((t - (times[i] as number)) * sog).toBeLessThanOrEqual(reach + 1e-9);
      });
    }
  });
});

describe("scoreSchedule", () => {
  test("a stopped coarse footprint is completed over the steps it skipped", () => {
    const calls: { t: number; stop: boolean; from?: number }[] = [];
    const refine = scoreSchedule([0, 10, 40], 10, (t, stop, from) => {
      calls.push({ t, stop, from });
      return { t, partial: stop } as FootprintResult;
    });
    refine.complete(2);
    // Completed with the same preceding time, so its hull still takes in 20 s and 30 s.
    expect(calls.at(-1)).toEqual({ t: 40, stop: false, from: 10 });
    expect(refine.footprints[2]?.partial).toBe(false);
  });

  test("a coarse footprint off the step grid refines its time on the grid steps it skipped", () => {
    const scored: number[] = [];
    const refine = scoreSchedule([0, 3, 7.6, 11], 3, (t) => {
      scored.push(t);
      return { t, risk: t >= 8 ? 1 : 0 } as FootprintResult;
    });
    scored.length = 0;
    expect(refine.firstTime(3, (f) => f.risk >= 1)).toBe(9);
    expect(scored).toEqual([9]);
    expect(refine.firstTime(2, (f) => f.risk >= 1)).toBe(7.6);
    expect(scored).toEqual([9, 6]);
  });
});
