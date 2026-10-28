import fc from "fast-check";
import type { NavState } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import { trackAt } from "../../src/engine/trajectory";
import { footprintRing } from "../../src/engine/footprint";
import type { LonLat } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import { pointInRing } from "../../src/foundation/geometry";
import type { VesselModel } from "../../src/model/vessel";
import { uniform } from "../helpers/arbitraries";
import { ctx } from "../helpers/engine";
import { fixtureIndex } from "../helpers/fixture-index";

/**
 * The footprints sweep the hull along the track at hull-length spacing (plan §4.8, step rule),
 * so where they lie, and when, never depends on the position buffer: a wider buffer or a less
 * certain position scores the same footprints wider (invariant 2), and the footprints cover
 * the track with no buffer at all.
 */

const NOW = 1_800_000_000_000;
const index = fixtureIndex();

function nav(lon: number, lat: number, cog: number, sog: number, rot: number, age = 0): NavState {
  const at = NOW - age * 1000;
  return {
    position: { value: [lon, lat], at },
    cog: { value: cog, at },
    sog: { value: sog, at },
    heading: { value: cog, at },
    rot: { value: rot, at }
  };
}

const navArb = fc.record({
  lon: uniform(22.002, 22.033),
  lat: uniform(60.001, 60.019),
  cog: uniform(0, 2 * Math.PI),
  sog: uniform(0.3, 20),
  rot: uniform(-0.02, 0.02),
  age: uniform(0, 8)
});

const vesselArb = fc.record({
  draft: uniform(0.5, 4),
  length: uniform(3, 40),
  beam: uniform(1, 10)
});

describe("footprints sweep the track whatever the position buffer", () => {
  test("the schedule and every footprint's hull are the same at any buffer or σ_pos", () => {
    fc.assert(
      fc.property(
        navArb,
        vesselArb,
        uniform(0, 50),
        uniform(0, 50),
        uniform(0, 40),
        uniform(0, 40),
        (n, vessel, b1, b2, s1, s2) => {
          const state = nav(n.lon, n.lat, n.cog, n.sog, n.rot, n.age);
          const run = (buffer: number, sigma: number) =>
            evaluateLookahead(state, { ...ctx(vessel), positionSigma: sigma }, index, NOW, {
              ...DEFAULT_LOOKAHEAD,
              positionBuffer: buffer
            }).footprints.map((f) => [f.t, f.ring]);
          expect(run(b2, s2)).toEqual(run(b1, s1));
        }
      ),
      {
        numRuns: 40,
        examples: [
          // From CI: a 0.008 m buffer at 3.4 m/s once spaced the footprints 2.98 s apart and a
          // 2.16 m one 3 s apart, though both footprints got the same 10 m buffer.
          [
            {
              lon: 22.002,
              lat: 60.001,
              cog: 2.6848050817578373,
              sog: 3.3553,
              rot: ((0.2154 - 0.5) * Math.PI) / 180,
              age: 0
            },
            { draft: 3.9629, length: 10, beam: 3 },
            0.008,
            2.162,
            0,
            0
          ]
        ]
      }
    );
  });

  test("with no buffer the footprints still cover the hull at every moment of a straight track", () => {
    const opts = { ...DEFAULT_LOOKAHEAD, positionBuffer: 0 };
    const mercator = (ring: LonLat[]) => ring.map((p) => toMercator(p[0], p[1]));
    fc.assert(
      fc.property(
        navArb,
        vesselArb,
        fc.array(fc.double({ min: 0, max: 1, noNaN: true })),
        (n, v, at) => {
          const vessel: VesselModel = v;
          const r = evaluateLookahead(
            nav(n.lon, n.lat, n.cog, n.sog, 0),
            { ...ctx(vessel), positionSigma: 0 },
            index,
            NOW,
            opts
          );
          const rings = r.footprints.map((f) => mercator(f.ring));
          const track = { course: n.cog, sog: n.sog, rot: 0 };
          const uncovered = at
            .map((u) => u * r.horizon)
            .flatMap((t) => {
              const p = trackAt([n.lon, n.lat], track, t).position;
              // Just inside the hull's corners: a point on an edge may fall either side.
              const hull = footprintRing(p, n.cog, 0.98 * vessel.length, 0.98 * vessel.beam);
              return mercator(hull).filter((c) => !rings.some((ring) => pointInRing(c, ring)));
            });
          expect(uncovered).toEqual([]);
        }
      ),
      { numRuns: 40 }
    );
  });
});
