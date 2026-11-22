import { routeDepsFor, type PluginState } from "../src/api-wiring";
import type { Clock } from "../src/monitor";
import { parseConfig } from "../src/config";
import { FixHistory, MIN_SAMPLES, SAMPLE_MS } from "../src/model/fix-history";

/** The route services' water levels before the plugin's monitor runs. */

const app = {
  resourcesApi: { getResource: () => Promise.resolve({}) },
  getSelfPath: () => undefined
} as unknown as Parameters<typeof routeDepsFor>[0];
const clock = { now: () => 0 } as unknown as Clock;
const state = { zoneErrors: [] } as unknown as PluginState;

describe("route dependencies with no monitor", () => {
  test("low and high water stand in as chart datum, marked as not measured", () => {
    const deps = routeDepsFor(app, clock, state);
    const at: [number, number][] = [[22, 60]];
    for (const level of [
      deps.waterLevel(0, 1, at),
      deps.waterLevelFor?.([])(0, 1, at),
      deps.highWater?.(0, 1, at),
      deps.highWaterFor?.([])(0, 1, at)
    ]) {
      expect(level?.h).toBe(0);
      expect(level?.degraded).toBe("plugin not started");
    }
  });
});

describe("the pilotage buffer a plan is checked at", () => {
  const T = Date.parse("2026-11-22T12:00:00Z");
  const at = { now: () => T } as unknown as Clock;

  test("kp times the planning σ, whatever the fix of the moment", () => {
    const fixes = new FixHistory();
    for (const live of [
      { sigmaPos: 0.3, ok: true },
      { sigmaPos: 4, ok: true },
      { sigmaPos: 1.5, ok: false }
    ]) {
      const s = {
        zoneErrors: [],
        config: parseConfig({}),
        monitor: { integrityResult: { ...live, reasons: [], divergence: null } },
        pilotage: { history: fixes }
      } as unknown as PluginState;
      // The configured σ 1.5 m at kp 2, while the history is too short to count.
      expect(routeDepsFor(app, at, s).pilotBuffer?.()).toBe(3);
    }
  });

  test("the boat's own history widens it when its fix has been worse", () => {
    const fixes = new FixHistory();
    for (let i = 0; i < MIN_SAMPLES; i++) {
      fixes.add(2.4, T - (MIN_SAMPLES - i) * SAMPLE_MS);
    }
    const s = {
      zoneErrors: [],
      config: parseConfig({}),
      pilotage: { history: fixes }
    } as unknown as PluginState;
    expect(routeDepsFor(app, at, s).pilotBuffer?.()).toBe(5);
  });
});
