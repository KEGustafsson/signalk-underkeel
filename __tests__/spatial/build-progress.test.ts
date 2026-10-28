import type { BuildProgress } from "../../src/spatial/build-progress";
import { throttled } from "../../src/spatial/build-progress";

describe("build progress messages", () => {
  test("a phase's first and last report go out, the rest at most every 2 s", () => {
    let now = 0;
    const sent: BuildProgress[] = [];
    const send = throttled(
      (p) => sent.push(p),
      2000,
      () => now
    );
    for (let done = 0; done <= 300; done++) {
      now += 50;
      send({ phase: "roots", done, total: 300 });
    }
    send({ phase: "save" });
    // 15 s of roots: the first, one every 2 s, the last, then the next phase.
    expect(sent).toHaveLength(10);
    expect(sent[0]).toEqual({ phase: "roots", done: 0, total: 300 });
    expect(sent[8]).toEqual({ phase: "roots", done: 300, total: 300 });
    expect(sent[9]).toEqual({ phase: "save" });
  });
});
