import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { sigmaFor, SWEPT_SIGMA_D } from "../../src/spatial/quality";
import type { ChartFeature } from "../../src/ingest/features";
import type { Box } from "../helpers/synthetic";
import { area, coverage, point, quality, swept } from "../helpers/synthetic";

// A CATZOC C chart with an 8 m swept fairway through a 12 m area.
const AREA: Box = [22.0, 60.0, 22.02, 60.01];
const FAIRWAY: Box = [22.0, 60.004, 22.02, 60.006];
const OPTS = { minZoom: 12, leafZoom: 18 };
const RISK = { threshold: 3.0, sigmaExtra: 0.3 };
/** Plan §4.7 alarm threshold on P(UKC < 0). */
const ALARM_P = 0.2;

function chart(extra: ChartFeature[], withFairway = true): ReturnType<typeof buildPyramid> {
  const f = [coverage(AREA), quality(AREA, 4), area(AREA, 12), ...extra];
  return buildPyramid(withFairway ? [...f, swept(FAIRWAY, 8)] : f, OPTS);
}

const at = (lon: number, lat: number) => footprintGeom([[lon, lat]]);

describe("σ depth in swept areas", () => {
  test("the swept depth itself carries the swept σ", () => {
    const r = minDepthOver(chart([]), at(22.01, 60.005));
    expect(r.dMin).toBe(8);
    expect(r.flags & FLAGS.SWEPT).toBeTruthy();
    expect(r.sigmaD).toBeCloseTo(SWEPT_SIGMA_D, 6);
  });

  test("a rock inside a swept fairway must alarm", () => {
    const rock = point(22.01, 60.005, 3.5);
    const inFairway = minDepthOver(chart([rock]), at(22.01, 60.005), { risk: RISK });
    const without = minDepthOver(chart([rock], false), at(22.01, 60.005), { risk: RISK });
    expect(inFairway.dMin).toBe(3.5);
    // The sweep guarantees 8 m, not the rock's 3.5 m: the survey's σ applies.
    expect(inFairway.riskTile?.sigmaD).toBeCloseTo(sigmaFor(4, 3.5).sigmaD, 6);
    expect(inFairway.maxRisk).toBeCloseTo(without.maxRisk, 9);
    expect(inFairway.maxRisk).toBeGreaterThanOrEqual(ALARM_P);
  });

  test("a sounding reaching into the fairway by its chart position keeps the survey σ", () => {
    // ~55 m south of the fairway's centre line, in CATZOC C water (σP 250 m).
    const sounding = point(22.01, 60.0035, 4.0, { objectClass: "SOUNDG" });
    const r = minDepthOver(chart([sounding]), at(22.01, 60.005), {
      risk: RISK,
      chartPosition: true
    });
    // The fairway itself is swept to 8 m; the sounding counts by its weight.
    expect(r.dMin).toBe(8);
    expect(r.riskTile?.dMin).toBe(4);
    expect(r.riskTile?.chart?.source).toBe("survey");
    // P(4 m) with the survey's σ, about 19 %, times Φ(−g/250 m), about 40 %.
    expect(r.riskTile?.sigmaD).toBeCloseTo(sigmaFor(4, 4).sigmaD, 6);
    expect(r.maxRisk).toBeGreaterThan(0.05);
    expect(r.maxRisk).toBeLessThan(0.1);
  });
});
