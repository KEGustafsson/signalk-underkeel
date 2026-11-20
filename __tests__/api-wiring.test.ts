import { routeDepsFor, type PluginState } from "../src/api-wiring";
import type { Clock } from "../src/monitor";

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
