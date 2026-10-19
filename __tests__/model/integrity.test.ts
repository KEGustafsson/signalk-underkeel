import type { LonLat } from "../../src/foundation/geo";
import { project } from "../../src/foundation/geo";
import type { IntegrityInputs } from "../../src/model/integrity";
import { DEFAULT_INTEGRITY, IntegrityMonitor } from "../../src/model/integrity";
import { DEFAULT_GNSS_SIGMA } from "../../src/model/position";

const T0 = 1_800_000_000_000;
const START: LonLat = [22.0, 60.0];
const EAST = Math.PI / 2;

/** A steady passage east at `stw` through water moving at `current` (east, north m/s). */
function passage(
  seconds: number,
  stw: number,
  current: [number, number] = [0, 0],
  extra: (t: number) => Partial<IntegrityInputs> = () => ({})
): { t: number; inputs: IntegrityInputs }[] {
  const ge = stw + current[0];
  const gn = current[1];
  const sog = Math.hypot(ge, gn);
  const cog = Math.atan2(ge, gn);
  return Array.from({ length: seconds + 1 }, (_, t) => ({
    t: T0 + t * 1000,
    inputs: {
      position: project(START, cog, sog * t),
      heading: EAST,
      stw,
      cog,
      sog,
      rot: 0,
      hdop: 1,
      methodQuality: "GNSS Fix",
      ...extra(t)
    }
  }));
}

function run(m: IntegrityMonitor, steps: { t: number; inputs: IntegrityInputs }[]) {
  return steps.map((s) => m.update(s.inputs, s.t));
}

describe("position integrity", () => {
  test("a consistent fix is ok with the GNSS σ", () => {
    const out = run(new IntegrityMonitor(), passage(300, 3));
    expect(out.every((r) => r.ok)).toBe(true);
    expect(out[300]).toMatchObject({ ok: true, reasons: [], sigmaPos: 3 });
    expect(Math.max(...out.map((r) => r.divergence ?? 0))).toBeLessThan(1);
  });

  test("a GNSS jump beyond 3 σ_DR inflates σ_pos to the divergence and says so", () => {
    const steps = passage(90, 3, [0, 0], (t) =>
      // 410 m on WGS84; haversine on the mean sphere reads it ~0.2 % shorter at 60° N.
      t >= 30 ? { position: project(project(START, EAST, 3 * t), 0, 410) } : {}
    );
    const out = run(new IntegrityMonitor(), steps);
    expect(out[29]?.ok).toBe(true);
    const jumped = out[30];
    expect(jumped?.ok).toBe(false);
    expect(jumped?.divergence).toBeGreaterThan(390);
    expect(jumped?.sigmaPos).toBe(jumped?.divergence);
    expect(jumped?.reasons[0]).toMatch(/^GNSS and dead reckoning differ by 4\d\d m$/);
    // A held offset stays flagged while the DR error is still small against it.
    expect(out[90]?.ok).toBe(false);
  });

  test("a steady current is learned, so drift is not a divergence", () => {
    const m = new IntegrityMonitor();
    const out = run(m, passage(1200, 2.5, [0.4, -0.6]));
    expect(out.every((r) => r.ok)).toBe(true);
    const [e, n] = m.currentEstimate();
    expect(e).toBeCloseTo(0.4, 1);
    expect(n).toBeCloseTo(-0.6, 1);
  });

  test("an unlearned current that grows slowly inside σ_DR is not flagged", () => {
    const out = run(new IntegrityMonitor(), passage(60, 3, [0.3, 0]));
    expect(out.every((r) => r.ok)).toBe(true);
  });

  test("a poor fix or a high HDOP inflates σ_pos and is reported", () => {
    const dr = run(
      new IntegrityMonitor(),
      passage(5, 3, [0, 0], () => ({ methodQuality: "Estimated (DR) mode" }))
    );
    expect(dr[5]).toMatchObject({ ok: false, reasons: ['GNSS fix quality "Estimated (DR) mode"'] });
    expect(dr[5]?.sigmaPos).toBe(DEFAULT_INTEGRITY.poorFixSigma);
    const hdop = run(
      new IntegrityMonitor(),
      passage(5, 3, [0, 0], () => ({ hdop: 6 }))
    );
    expect(hdop[5]).toMatchObject({ ok: false, reasons: ["HDOP 6.0"], sigmaPos: 18 });
  });

  test("without speed through water the check reports itself unavailable", () => {
    const r = new IntegrityMonitor().update(
      { position: START, heading: EAST, hdop: undefined },
      T0
    );
    expect(r).toMatchObject({
      ok: true,
      divergence: null,
      sigmaPos: DEFAULT_GNSS_SIGMA,
      unchecked: "dead reckoning unavailable: no heading or speed through water"
    });
    expect(new IntegrityMonitor().update({}, T0).unchecked).toBe(
      "dead reckoning unavailable: no position"
    );
  });

  test("a repeated fix with the same timestamp does not advance dead reckoning", () => {
    const m = new IntegrityMonitor();
    const [first] = passage(0, 3);
    m.update(first!.inputs, first!.t);
    const again = m.update(first!.inputs, first!.t);
    expect(again.divergence).toBe(0);
  });
});
