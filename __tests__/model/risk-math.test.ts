import fc from "fast-check";
import { normalCdf, probabilityBelowZero } from "../../src/foundation/stats";
import { MAX_ROLL, RollWindow, heel, squat, waveAllowance } from "../../src/model/allowances";
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
  test("Barrass squat, doubled when confined", () => {
    // 10 kn = 5.144 m/s; Cb 0.4 → 0.4 × 100 / 100 = 0.4 m
    const s = squat(10 * (1852 / 3600), { blockCoefficient: 0.4, confined: false });
    expect(s.value).toBeCloseTo(0.4, 9);
    expect(s.sigma).toBeCloseTo(0.12, 9);
    expect(squat(10 * (1852 / 3600), { blockCoefficient: 0.4, confined: true }).value).toBeCloseTo(
      0.8,
      9
    );
    expect(squat(-3, DEFAULT_DYNAMICS).value).toBe(0);
  });

  test("heel models", () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    const at = (d: number) => ({ least: deg(d), most: deg(d) });
    expect(heel(at(20), 2, { kind: "none" }).value).toBe(0);
    expect(heel(at(60), 2, { kind: "fin" }).value).toBeCloseTo(-1, 9);
    // A fin keel lifts only as far as the least roll in the window allows.
    expect(heel({ least: deg(0), most: deg(40) }, 2, { kind: "fin" }).value).toBe(0);
    expect(heel(undefined, 2, { kind: "fin" }).value).toBe(0);
    const table = {
      kind: "table" as const,
      points: [
        { heel: deg(20), delta: 0.1 },
        { heel: 0, delta: 0 }
      ]
    };
    expect(heel(at(10), 1, table).value).toBeCloseTo(0.05, 9);
    expect(heel(at(40), 1, table).value).toBeCloseTo(0.1, 9);
    expect(heel(at(0), 1, table).value).toBe(0);
    expect(heel(undefined, 1, { kind: "table", points: [] }).value).toBe(0);
    // A keel that digs in most at mid heel: the deepest point over the range counts.
    const peak = {
      kind: "table" as const,
      points: [
        { heel: 0, delta: 0 },
        { heel: deg(15), delta: 0.3 },
        { heel: deg(30), delta: 0.1 }
      ]
    };
    expect(heel({ least: deg(5), most: deg(25) }, 1, peak).value).toBeCloseTo(0.3, 9);
    expect(heel({ least: deg(0), most: deg(10) }, 1, peak).value).toBeCloseTo(0.2, 9);
    // Without roll the largest change in the table applies.
    expect(heel(undefined, 1, peak).value).toBeCloseTo(0.3, 9);
  });

  test("the roll window keeps the least roll of 10 s and refuses impossible rolls", () => {
    const T = 1_800_000_000_000;
    const w = new RollWindow();
    expect(w.range(T)).toBeUndefined();
    for (let k = 0; k < 10; k++) {
      w.record(k % 2 === 0 ? 0.7 : -0.05, T + k * 1000);
    }
    expect(w.range(T + 9000)).toEqual({ least: 0.05, most: 0.7 });
    w.record(0.6, T + 15_000);
    w.record(0.6, T + 15_000);
    expect(w.range(T + 15_000)).toEqual({ least: 0.05, most: 0.7 });
    expect(w.range(T + 25_000)).toBeUndefined();
    const wild = new RollWindow();
    wild.record(0.3, T);
    wild.record(MAX_ROLL + 0.01, T + 1000);
    expect(wild.range(T + 1000)).toBeUndefined();
    wild.record(0.3, T + 11_000);
    expect(wild.range(T + 11_000)).toEqual({ least: 0.3, most: 0.3 });
  });

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
    { speed: 0 },
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
      "charted 2.4 m (±1.06 m, UNASSESSED) − 0.3 m water level (manual) − draft 2 m − squat 0 m + heel 0 m − wave 0 m − margin 0.2 m → μ = −0.1 m, σ = 1.08 m, P = 54 %"
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
