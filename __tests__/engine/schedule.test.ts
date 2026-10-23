import type { FootprintResult } from "../../src/engine/lookahead";
import { scoreSchedule } from "../../src/engine/schedule";

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
});
