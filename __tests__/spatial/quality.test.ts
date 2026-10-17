import { accuracyFor, sigmaFor } from "../../src/spatial/quality";

describe("CATZOC → σ", () => {
  test("table values are halved 95 % bounds", () => {
    expect(sigmaFor(1, 10)).toEqual({ sigmaP: 2.5, sigmaD: (0.5 + 0.1) / 2 });
    expect(sigmaFor(2, 10).sigmaP).toBe(10);
    expect(sigmaFor(3, 10).sigmaP).toBe(25);
    expect(sigmaFor(4, 10)).toEqual({ sigmaP: 250, sigmaD: (2 + 0.5) / 2 });
  });

  test("D and unassessed use twice C", () => {
    expect(sigmaFor(5, 10)).toEqual({ sigmaP: 500, sigmaD: (4 + 1) / 2 });
    expect(sigmaFor(6, 10)).toEqual(sigmaFor(undefined, 10));
    expect(accuracyFor(6)).toEqual(accuracyFor(5));
  });

  test("stated POSACC/SOUACC only widen", () => {
    expect(sigmaFor(1, 0, { posacc: 50 }).sigmaP).toBe(25);
    expect(sigmaFor(1, 0, { posacc: 1 }).sigmaP).toBe(2.5);
    expect(sigmaFor(1, 0, { souacc: 3 }).sigmaD).toBe(1.5);
  });

  test("land and drying depths use the fixed term only", () => {
    expect(sigmaFor(4, -Infinity).sigmaD).toBe(1);
    expect(sigmaFor(4, -2).sigmaD).toBe(1);
  });
});
