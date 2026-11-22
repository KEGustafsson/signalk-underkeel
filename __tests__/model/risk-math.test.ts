import fc from "fast-check";
import { normalCdf, probabilityBelowZero } from "../../src/foundation/stats";
import { waveAllowance } from "../../src/model/allowances";
import { sigmaExtra, thresholdDepth, ukcAt } from "../../src/model/uncertainty";
import { DEFAULT_DYNAMICS, vesselTerms } from "../../src/model/vessel";
import { explain, sentence } from "../../src/engine/explain";
import { uniform } from "../helpers/arbitraries";

describe("normal CDF", () => {
  test.each([
    [0, 0.5],
    [1, 0.841344746],
    [-1, 0.158655254],
    [1.6448536, 0.95],
    [-2.3263479, 0.01],
    [3, 0.998650102]
  ])("Φ(%p) ≈ %p", (x, p) => {
    expect(normalCdf(x)).toBeCloseTo(p, 6);
  });

  test("limits and monotonicity", () => {
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(-Infinity)).toBe(0);
    fc.assert(
      fc.property(uniform(-8, 8), uniform(0, 1), (x, d) => {
        expect(normalCdf(x + d)).toBeGreaterThanOrEqual(normalCdf(x) - 1e-7);
      })
    );
  });

  test("P(UKC < 0) edge cases", () => {
    expect(probabilityBelowZero(-Infinity, 1)).toBe(1);
    expect(probabilityBelowZero(-0.1, 0)).toBe(1);
    expect(probabilityBelowZero(0.1, 0)).toBe(0);
    expect(probabilityBelowZero(0, 1)).toBeCloseTo(0.5, 7);
  });
});

describe("dynamic draft terms", () => {
  test("wave allowance", () => {
    expect(waveAllowance(1.5, 0.4)).toEqual({
      value: 0.6000000000000001,
      sigma: 0.30000000000000004
    });
    expect(waveAllowance(undefined, 0.4)).toEqual({ value: 0, sigma: 0 });
  });
});

describe("UKC composition", () => {
  const v = vesselTerms(
    { draft: 2, length: 10, beam: 3 },
    {},
    { ...DEFAULT_DYNAMICS, margin: 0.2 }
  );
  const wl = { h: -0.3, sigma: 0.2, source: "manual" };

  test("threshold and σ fold every term but the chart", () => {
    expect(thresholdDepth(v, wl)).toBeCloseTo(2 + 0.2 + 0.3, 9);
    expect(sigmaExtra(v, wl)).toBeCloseTo(Math.hypot(0.2, 0.05), 9);
    const u = ukcAt(3, 0.4, v, wl);
    expect(u.mean).toBeCloseTo(0.5, 9);
    expect(u.sigma).toBeCloseTo(Math.hypot(0.4, 0.2, 0.05), 9);
    expect(u.risk).toBeCloseTo(normalCdf(-0.5 / u.sigma), 9);
  });

  test("the sentence lists every term and the result", () => {
    const e = explain({ dMin: 2.4, sigmaD: 1.06 }, { flags: ["UNASSESSED"] }, v, wl);
    expect(sentence(e)).toBe(
      "charted 2.4 m (±1.06 m, UNASSESSED) − 0.3 m water level (manual) − draft 2 m − wave 0 m − margin 0.2 m → μ = −0.1 m, σ = 1.08 m, P = 54 %"
    );
    const land = explain(
      { dMin: -Infinity, sigmaD: 0 },
      { flags: [], hazard: { class: "LNDARE", depth: -Infinity } },
      v,
      wl
    );
    expect(land.charted).toBeNull();
    expect(land.mean).toBeNull();
    expect(sentence(land)).toMatch(/^land LNDARE .* μ = −∞ m, .* P = > 99 %$/);
    const safe = explain({ dMin: 9, sigmaD: 0.1 }, { flags: [] }, v, wl);
    expect(sentence(safe)).toMatch(/P = 0 %$/);
    const tiny = explain({ dMin: 3.6, sigmaD: 0.3 }, { flags: [] }, v, wl);
    expect(sentence(tiny)).toMatch(/P = < 1 %$/);
  });
});
