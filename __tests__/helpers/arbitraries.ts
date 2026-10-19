import fc from "fast-check";

/**
 * A number drawn evenly from [min, max] on a grid of `steps` intervals.
 * fc.double picks among float bit patterns, so over [0, 1] about nine draws
 * in ten fall below 1e-6; a property built on it explores almost nothing
 * but the range's ends.
 */
export function uniform(min: number, max: number, steps = 10_000): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: steps }).map((i) => min + ((max - min) * i) / steps);
}

export const fraction = uniform(0, 1);
