import fc from "fast-check";
import { float32AtMost } from "../../src/foundation/float32";

/** A depth kept in a float32 column must never read deeper than the chart (invariant 1). */
describe("float32AtMost", () => {
  test("is a float32 no greater than its input, and the nearest such", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (d) => {
        const f = float32AtMost(d);
        expect(Math.fround(f)).toBe(f);
        expect(f).toBeLessThanOrEqual(d);
        // The next float32 up is above d: nothing nearer was skipped.
        const up = new Float32Array([f]);
        const bits = new Int32Array(up.buffer);
        bits[0] = (bits[0] as number) + (f >= 0 ? 1 : -1);
        if (f !== 0) {
          expect(up[0] as number).toBeGreaterThan(d);
        }
      })
    );
  });

  test("keeps depths a float32 holds exactly, and the infinities", () => {
    expect(float32AtMost(1.5)).toBe(1.5);
    expect(float32AtMost(-Infinity)).toBe(-Infinity);
    expect(float32AtMost(Infinity)).toBe(Infinity);
    expect(float32AtMost(1.8)).toBeLessThanOrEqual(1.8);
    expect(float32AtMost(-1e-50)).toBeLessThan(0);
  });
});
