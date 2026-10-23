import { parseConfig } from "../src/config";

/** The box built around the vessel, as configured. */

describe("boxRadiusKm", () => {
  test("0 turns the box off; under the 2 km minimum it is raised to 2, not reset to 10", () => {
    expect(parseConfig({ boxRadiusKm: 0 }).boxRadiusKm).toBe(0);
    expect(parseConfig({ boxRadiusKm: 0.5 }).boxRadiusKm).toBe(2);
    expect(parseConfig({ boxRadiusKm: 1 }).boxRadiusKm).toBe(2);
    expect(parseConfig({ boxRadiusKm: 7 }).boxRadiusKm).toBe(7);
    expect(parseConfig({ boxRadiusKm: -1 }).boxRadiusKm).toBe(10);
    expect(parseConfig({}).boxRadiusKm).toBe(10);
  });
});
