import fc from "fast-check";
import { convexHull } from "../../src/engine/footprint";
import { escapeTrack, fanMembers, trackAt } from "../../src/engine/trajectory";
import type { LonLat } from "../../src/foundation/geo";
import { haversine, project } from "../../src/foundation/geo";
import { DEFAULT_GNSS_SIGMA, gnssSigma, UERE } from "../../src/model/position";

const ORIGIN: LonLat = [22.0, 60.0];
const DEG = Math.PI / 180;

/** East and north metres from ORIGIN. */
function en(p: LonLat): [number, number] {
  const m = 111320;
  return [(p[0] - ORIGIN[0]) * m * Math.cos((ORIGIN[1] * Math.PI) / 180), (p[1] - ORIGIN[1]) * m];
}

describe("CTRV tracks", () => {
  test("a straight track is the projected run", () => {
    const p = trackAt(ORIGIN, { course: 1, sog: 4, rot: 0 }, 50);
    expect(haversine(p.position, project(ORIGIN, 1, 200))).toBeLessThan(0.01);
    expect(p.course).toBe(1);
  });

  test("a quarter turn to starboard from north ends one radius east and north", () => {
    const rot = 2 * DEG;
    const t = Math.PI / 2 / rot;
    const r = 5 / rot;
    const p = trackAt(ORIGIN, { course: 0, sog: 5, rot }, t);
    const [e, n] = en(p.position);
    expect(e).toBeCloseTo(r, -0.5);
    expect(n).toBeCloseTo(r, -0.5);
    expect(p.course).toBeCloseTo(Math.PI / 2, 12);
  });

  test("the distance run along an arc is sog · t whatever the turn", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: 0.5, max: 10, noNaN: true }),
        (rotDeg, sog) => {
          const rot = rotDeg * DEG;
          const t = 30;
          const chord = haversine(ORIGIN, trackAt(ORIGIN, { course: 0.3, sog, rot }, t).position);
          const angle = Math.abs(rot * t);
          const expected =
            angle < 1e-9 ? sog * t : ((2 * sog) / Math.abs(rot)) * Math.sin(angle / 2);
          // project works on WGS84, haversine on the mean sphere: up to 0.4 % apart at 60° N.
          expect(Math.abs(chord - expected)).toBeLessThan(0.005 * sog * t + 0.01);
        }
      )
    );
  });

  test("a turn held for turnFor seconds then runs straight on the new course", () => {
    const rot = 3 * DEG;
    const track = { course: 0, sog: 2, rot, turnFor: 10 };
    expect(trackAt(ORIGIN, track, 40).course).toBeCloseTo(30 * DEG, 12);
    const at10 = trackAt(ORIGIN, track, 10);
    const at40 = trackAt(ORIGIN, track, 40);
    expect(haversine(at40.position, project(at10.position, 30 * DEG, 60))).toBeLessThan(0.01);
  });

  test("the fan is the central member, ROT ± σ and COG ± σ", () => {
    const members = fanMembers(1, 3, 0.01, { cog: 0.1, rot: 0.002 }, 60);
    expect(members.map((m) => [m.course, m.rot])).toEqual([
      [1, 0.01],
      [1, 0.012],
      [1, 0.008],
      [1.1, 0.01],
      [0.9, 0.01]
    ]);
    expect(members.every((m) => m.turnFor === 60 && m.sog === 3)).toBe(true);
  });

  test("an escape track turns at the maximum rate until the new heading", () => {
    expect(escapeTrack(1, 3, -0.5, 0.05)).toEqual({ course: 1, sog: 3, rot: -0.05, turnFor: 10 });
    expect(escapeTrack(1, 3, 0, 0.05)).toEqual({ course: 1, sog: 3, rot: 0, turnFor: 0 });
  });
});

describe("hull of footprints", () => {
  test("contains every input point", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.double({ min: 22, max: 22.01, noNaN: true }),
            fc.double({ min: 60, max: 60.01, noNaN: true })
          ),
          {
            minLength: 3,
            maxLength: 30
          }
        ),
        (pts) => {
          const hull = convexHull(pts as LonLat[]);
          const n = hull.length;
          for (const p of pts) {
            for (let i = 0; i < n && n >= 3; i++) {
              const a = hull[i] as LonLat;
              const b = hull[(i + 1) % n] as LonLat;
              const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
              expect(cross).toBeGreaterThanOrEqual(-1e-15);
            }
          }
        }
      )
    );
  });
});

describe("GNSS position σ", () => {
  test("HDOP times the range error, or the default without HDOP", () => {
    expect(gnssSigma(1.2)).toBeCloseTo(1.2 * UERE, 12);
    expect(gnssSigma(undefined)).toBe(DEFAULT_GNSS_SIGMA);
    expect(gnssSigma(0)).toBe(DEFAULT_GNSS_SIGMA);
    expect(gnssSigma(NaN)).toBe(DEFAULT_GNSS_SIGMA);
  });
});
