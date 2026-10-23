import fc from "fast-check";
import type { NavState } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import { lengthAt } from "../../src/engine/fan";
import { footprintRing } from "../../src/engine/footprint";
import { fanMembers, trackAt } from "../../src/engine/trajectory";
import type { LonLat } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import type { VesselModel } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { uniform } from "../helpers/arbitraries";
import { ctx } from "../helpers/engine";
import { basin } from "../helpers/synthetic";

/**
 * The footprint at t = 0 covers the vessel at its position fix as well as
 * where the fix's age projects it now (plan §4.8, invariant 1). The age
 * includes any skew between the source's clock and the server's, so the
 * boat may still be at the fix: a footprint only ahead of it would leave
 * the water ahead of its bow unread.
 */

const NOW = 1_800_000_000_000;
const KEEL: VesselModel = { draft: 1.9, length: 12, beam: 4 };

const index: ChartIndex = {
  catalogue: { version: 1, cells: [] },
  pyramid: buildPyramid(basin([21.9, 59.95, 22.1, 60.05], 20), { minZoom: 12, leafZoom: 16 }),
  hazards: new HazardIndex([])
};

/** Whether `p` lies in the convex ring, taken in Mercator, within `slack` metres. */
function inConvex(p: LonLat, ring: LonLat[], slack = 1e-3): boolean {
  const pts = ring.map((q) => toMercator(q[0], q[1]));
  const [x, y] = toMercator(p[0], p[1]);
  let area = 0;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length] as [number, number];
    area += a[0] * b[1] - b[0] * a[1];
  });
  const sign = Math.sign(area);
  return pts.every((a, i) => {
    const b = pts[(i + 1) % pts.length] as [number, number];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    return (sign * cross) / Math.hypot(b[0] - a[0], b[1] - a[1]) >= -slack;
  });
}

const navArb = fc.record({
  age: uniform(0, DEFAULT_LOOKAHEAD.staleAfter - 0.1),
  sog: uniform(0.5, 15),
  cog: uniform(0, 2 * Math.PI),
  drift: uniform(-0.2, 0.2),
  rot: uniform(-0.05, 0.05)
});

type Nav = { age: number; sog: number; cog: number; drift: number; rot: number };

function navOf(n: Nav): NavState {
  return {
    position: { value: [22.0, 60.0], at: NOW - n.age * 1000 },
    cog: { value: n.cog, at: NOW },
    sog: { value: n.sog, at: NOW },
    heading: { value: n.cog + n.drift, at: NOW },
    rot: { value: n.rot, at: NOW }
  };
}

test("the first footprint covers the hull at the fix, the hull now and the track between", () => {
  const opts = DEFAULT_LOOKAHEAD;
  fc.assert(
    fc.property(navArb, (n) => {
      const r = evaluateLookahead(navOf(n), ctx(KEEL), index, NOW);
      const first = r.footprints[0];
      expect(first?.t).toBe(0);
      const ring = (first as { ring: LonLat[] }).ring;
      const origin: LonLat = [22.0, 60.0];
      const sigma = { cog: opts.sigmaCog, rot: opts.sigmaRot };
      const central = fanMembers(n.cog, n.sog, n.rot, sigma, opts.turnFor)[0];
      const track = central as NonNullable<typeof central>;
      const hullAt = (s: number): LonLat[] => {
        const p = trackAt(origin, track, s);
        const heading = n.cog + n.drift + (p.course - n.cog);
        return footprintRing(p.position, heading, lengthAt(s, KEEL, opts), KEEL.beam);
      };
      for (const corner of [...hullAt(0), ...hullAt(n.age)]) {
        expect(inConvex(corner, ring)).toBe(true);
      }
      // Between the fix and now the boat ran along the track: no stretch of it is left unread.
      for (let i = 1; i < 10; i++) {
        expect(inConvex(trackAt(origin, track, (n.age * i) / 10).position, ring)).toBe(true);
      }
    }),
    { numRuns: 200, examples: [[{ age: 8, sog: 8, cog: Math.PI / 2, drift: 0, rot: 0 }]] }
  );
});
