import type { ChartBoxView } from "../../src/engine/chart-box";
import {
  boxCoverage,
  explainOutsideBox,
  insideBox,
  OUTSIDE_BOX_REASON,
  spoken,
  withBoxReason
} from "../../src/engine/chart-box";
import type { FootprintResult, LookaheadResult } from "../../src/engine/lookahead";
import type { LegResult, RouteCheckResult } from "../../src/engine/route-check";
import type { LonLat } from "../../src/foundation/geo";
import { project } from "../../src/foundation/geo";
import { boxAround } from "../../src/ingest/wfs";

/**
 * No coverage at the chart box edge says so in its reason; no coverage inside the box, where
 * the charts have none, keeps its reason. Neither changes the state (invariant 3).
 */

const CENTRE: LonLat = [22.08, 60.07];
const BBOX = boxAround(CENTRE, 10);
const east = (m: number): LonLat => project(CENTRE, Math.PI / 2, m);

function fp(t: number, center: LonLat, buffer = 20): FootprintResult {
  const ring = [0, 1, 2, 3].map((k) => project(center, (k * Math.PI) / 2, buffer));
  return {
    t,
    center,
    ring: [...ring, ring[0] as LonLat],
    buffer,
    charted: null,
    mean: null,
    sigma: 0,
    risk: 0,
    uncovered: true,
    flags: 0,
    sigmaP: 0
  };
}

const REBUILDING: ChartBoxView = { bbox: BBOX, rebuilding: true, failed: false, lastMs: 300_000 };

describe("no-coverage reasons at the chart box", () => {
  test("outside the box while it is rebuilt the reason says so and keeps its start", () => {
    expect(boxCoverage("no chart coverage at the vessel", [fp(0, east(12_000))], REBUILDING)).toBe(
      "no chart coverage at the vessel: outside the chart box, the box is rebuilding around the vessel (last build took 5 min)"
    );
  });

  test("inside the box, away from its edge, no coverage is the charts' and reads as before", () => {
    const fps = [fp(0, east(1000))];
    expect(boxCoverage("no chart coverage at the vessel", fps, REBUILDING)).toBe(
      "no chart coverage at the vessel"
    );
  });

  test("within chart position reach of the edge it is the box edge", () => {
    const fps = [fp(0, east(9000))];
    expect(boxCoverage("no chart coverage at the vessel", fps, REBUILDING)).toMatch(
      /^no chart coverage at the vessel: at the chart box edge, /
    );
  });

  test("a gap ahead is judged at the footprint the reason names", () => {
    const fps = [fp(0, east(1000)), fp(30, east(2000)), fp(60, east(11_000))];
    const box = { ...REBUILDING, lastMs: undefined };
    expect(boxCoverage("no chart coverage ahead in 30 s", fps, box)).toBe(
      "no chart coverage ahead in 30 s"
    );
    expect(boxCoverage("no chart coverage ahead in 60 s", fps, box)).toBe(
      "no chart coverage ahead in 60 s: outside the chart box, the box is rebuilding around the vessel"
    );
  });

  test("with no rebuild running the reason says whether one failed or is due", () => {
    const fps = [fp(0, east(12_000))];
    const idle = { bbox: BBOX, rebuilding: false, failed: false };
    expect(boxCoverage("no chart coverage at the vessel", fps, idle)).toMatch(
      /outside the chart box, a box rebuild is due$/
    );
    expect(boxCoverage("no chart coverage at the vessel", fps, { ...idle, failed: true })).toMatch(
      /outside the chart box, the box rebuild failed and is retried$/
    );
  });

  test("other reasons and a service with no box yet are left alone", () => {
    const fps = [fp(0, east(12_000))];
    expect(boxCoverage("shoal ahead in 40 s", fps, REBUILDING)).toBe("shoal ahead in 40 s");
    const none = { rebuilding: true, failed: false };
    expect(boxCoverage("no chart coverage at the vessel", fps, none)).toBe(
      "no chart coverage at the vessel"
    );
  });

  test("only the reason changes: state, risk and time to shoal stay", () => {
    for (const state of ["warn", "alarm", "alert", "unknown", "normal", "off"] as const) {
      const r = {
        state,
        reason: "no chart coverage at the vessel",
        risk: 0.3,
        timeToShoal: 0,
        footprints: [fp(0, east(12_000))]
      } as unknown as LookaheadResult;
      const out = withBoxReason(r, REBUILDING);
      expect({ ...out, reason: r.reason }).toEqual(r);
      expect(out.reason).not.toBe(r.reason);
    }
    const r = { state: "warn", reason: "x", footprints: [] } as unknown as LookaheadResult;
    expect(withBoxReason(r, undefined)).toBe(r);
  });

  test("insideBox measures metres to each edge, across the antimeridian too", () => {
    expect(insideBox(east(9000), BBOX, 900)).toBe(true);
    expect(insideBox(east(9000), BBOX, 1100)).toBe(false);
    const wrapped = boxAround([179.99, 0], 10);
    expect(insideBox([-179.99, 0], wrapped)).toBe(true);
  });

  test("durations read in tens of seconds, then minutes", () => {
    expect([spoken(4000), spoken(32_000), spoken(89_000), spoken(300_000)]).toEqual([
      "0 s",
      "30 s",
      "90 s",
      "5 min"
    ]);
  });
});

describe("route legs outside the chart box", () => {
  const leg = (from: LonLat, to: LonLat, status: LegResult["status"], flags: string[]) =>
    ({ index: 0, status, from, to, flags }) as unknown as LegResult;
  const result = (legs: LegResult[]) => ({ legs }) as unknown as RouteCheckResult;

  test("an unverified leg past the box says why; one inside the box keeps its flags alone", () => {
    const out = explainOutsideBox(
      result([
        leg(east(0), east(15_000), "unverified", ["NO_COVERAGE"]),
        leg(east(0), east(2000), "unverified", ["NO_COVERAGE"]),
        leg(east(0), east(15_000), "unverified", ["UNASSESSED"]),
        leg(east(0), east(15_000), "fail", ["NO_COVERAGE", "LAND"])
      ]),
      BBOX,
      50
    );
    expect(out.legs.map((l) => l.reason)).toEqual([
      OUTSIDE_BOX_REASON,
      undefined,
      undefined,
      undefined
    ]);
    expect(out.legs.map((l) => l.status)).toEqual([
      "unverified",
      "unverified",
      "unverified",
      "fail"
    ]);
  });

  test("the corridor's half-width counts: a leg along the edge reaches past it", () => {
    const along = leg(project(east(8000), 0, -2000), project(east(8000), 0, 2000), "unverified", [
      "NO_COVERAGE"
    ]);
    expect(explainOutsideBox(result([along]), BBOX, 10).legs[0]?.reason).toBeUndefined();
    expect(explainOutsideBox(result([along]), BBOX, 200).legs[0]?.reason).toBe(OUTSIDE_BOX_REASON);
  });

  test("with no box (a whole index) nothing changes", () => {
    const r = result([leg(east(0), east(15_000), "unverified", ["NO_COVERAGE"])]);
    expect(explainOutsideBox(r, undefined, 50)).toBe(r);
  });
});
