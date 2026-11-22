import { drain } from "../../src/engine/route-check";
import { ROOM_STEP, roomSteps } from "../../src/engine/room";

/** A leg's room (`engine/room.ts`): the edge of the buffers whose corridor stays swept. */

const upTo = (edge: number) =>
  // eslint-disable-next-line require-yield
  function* (buffer: number): Generator<void, boolean, void> {
    return buffer <= edge;
  };

describe("a leg's room", () => {
  test("the widest passing buffer, to ROOM_STEP, never past the edge", () => {
    for (const edge of [2.01, 3.3, 4.37, 7.9, 9.99]) {
      const room = drain(roomSteps(upTo(edge), [2, 10]));
      expect(room).toBeLessThanOrEqual(edge);
      expect(room).toBeGreaterThan(edge - ROOM_STEP - 0.1);
    }
  });

  test("the top of the range when it passes there", () => {
    expect(drain(roomSteps(upTo(12), [2, 10]))).toBe(10);
  });
});
