import { parseConfig } from "../src/config";
import type { FetchLike } from "../src/model/fmi";
import { WaterLevelService } from "../src/water-level-service";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const noFetch: FetchLike = () => Promise.reject(new Error("offline"));

describe("water-level service", () => {
  test("the Signal K tide source reads heightNow, heightLow and timeLow", () => {
    const s = new WaterLevelService(
      parseConfig({ waterLevel: { source: "signalk-tide" } }),
      undefined,
      noFetch
    );
    expect(s.paths()).toEqual([
      "environment.tide.heightNow",
      "environment.tide.heightLow",
      "environment.tide.timeLow"
    ]);
    expect(s.record("environment.tide.timeLow", new Date(NOW).toISOString(), NOW)).toBe(true);
  });
});
