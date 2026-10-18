import { GroundingDetector } from "../../src/engine/grounding-detect";

const T0 = 1_800_000_000_000;

/** SOG 3 m/s, then 0.4 m/s two seconds later, with depth 1.9 m under a 1.8 m draft. */
function grounding(d: GroundingDetector, extra: (at: number) => void = () => undefined): void {
  d.record("navigation.speedOverGround", 3, T0);
  d.record("navigation.speedOverGround", 2.8, T0 + 1000);
  d.record("environment.depth.belowSurface", 1.9, T0 + 2000);
  extra(T0 + 2000);
  d.record("navigation.speedOverGround", 0.4, T0 + 3000);
}

describe("grounding detector", () => {
  test("a sudden stop in water as shallow as the keel is a grounding", () => {
    const d = new GroundingDetector();
    grounding(d);
    const g = d.check(T0 + 3000, 1.8, 0);
    expect(g.grounded).toBe(true);
    expect(g.reasons).toEqual(["SOG fell from 3.0 to 0.4 m/s", "depth 1.9 m against draft 1.8 m"]);
  });

  test("a gear change, deep water or a gradual stop is not", () => {
    const gear = new GroundingDetector();
    grounding(gear, (at) => gear.record("propulsion.port.transmission.gear", "reverse", at));
    expect(gear.check(T0 + 3000, 1.8, 0).grounded).toBe(false);
    const deep = new GroundingDetector();
    grounding(deep);
    expect(deep.check(T0 + 3000, 1.2, 0).grounded).toBe(false);
    const slow = new GroundingDetector();
    // 3 → 0.4 m/s over 30 s: at most a 50 % fall within any 5 s.
    for (let k = 0; k <= 30; k++) {
      slow.record("navigation.speedOverGround", 3 - (2.6 * k) / 30, T0 + k * 1000);
    }
    slow.record("environment.depth.belowSurface", 1.9, T0 + 30_000);
    expect(slow.check(T0 + 30_000, 1.8, 0).grounded).toBe(false);
  });

  test("P ≥ 80 % under the vessel stands in for measured depth", () => {
    const d = new GroundingDetector();
    d.record("navigation.speedOverGround", 3, T0);
    d.record("navigation.speedOverGround", 0.2, T0 + 2000);
    expect(d.check(T0 + 2000, 1.8, 0.9).reasons[1]).toBe("P(UKC < 0) 90 % under the vessel");
  });

  test("with an IMU path the deceleration spike is required", () => {
    const opts = { imuPath: "navigation.acceleration.x", decelThreshold: 2 };
    const without = new GroundingDetector(opts);
    grounding(without);
    expect(without.check(T0 + 3000, 1.8, 0).grounded).toBe(false);
    const withSpike = new GroundingDetector(opts);
    grounding(withSpike, (at) => withSpike.record("navigation.acceleration.x", -4, at));
    expect(withSpike.check(T0 + 3000, 1.8, 0).reasons).toContain("deceleration spike");
    expect(withSpike.paths()).toContain("navigation.acceleration.x");
  });

  test("once fired it holds until under way for 10 s", () => {
    const d = new GroundingDetector();
    grounding(d);
    expect(d.check(T0 + 3000, 1.8, 0).grounded).toBe(true);
    expect(d.check(T0 + 60_000, 1.8, 0).grounded).toBe(true);
    for (let k = 0; k <= 10; k++) {
      d.record("navigation.speedOverGround", 1.5, T0 + 61_000 + k * 1000);
      const g = d.check(T0 + 61_000 + k * 1000, 1.8, 0);
      expect(g.grounded).toBe(k < 10);
    }
  });
});
