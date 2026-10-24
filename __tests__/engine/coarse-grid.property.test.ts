import fc from "fast-check";
import type { Motion, Scoring } from "../../src/engine/fan";
import { footprint, spanOf } from "../../src/engine/fan";
import type { FootprintResult } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import { scheduleFor } from "../../src/engine/schedule";
import { fanMembers } from "../../src/engine/trajectory";
import type { LonLat } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import { gnssSigma } from "../../src/model/position";
import { sigmaExtra, thresholdDepth } from "../../src/model/uncertainty";
import type { VesselModel } from "../../src/model/vessel";
import { DEFAULT_DYNAMICS, vesselTerms } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { uniform } from "../helpers/arbitraries";
import { CHART_DATUM } from "../helpers/engine";
import { basin, point } from "../helpers/synthetic";

/**
 * A long horizon at speed spaces coarse footprints off the step grid (plan
 * §4.8). Each still takes in the footprint of every plan step it stands for,
 * so under graded chart position (plan §4.3) it reads every tile at least as
 * near: never a lower P or less of the chart's flags than with every step
 * scored. With the warn window inside the 60 s a turn lasts, coarse
 * footprints fall in the turn, where a step's footprint is not between its
 * neighbours.
 */

const KEEL: VesselModel = { draft: 1.9, length: 12, beam: 4 };
const opts = {
  ...DEFAULT_LOOKAHEAD,
  distance: 5 * 1852,
  warnWithin: 30,
  alarmWithin: 30
};

/** A seeded field of shoal rocks in 20 m water, wider than 5 NM around 22 E, 60 N. */
function rockField(): ChartIndex {
  let seed = 11;
  const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const rocks = Array.from({ length: 200 }, () =>
    point(21.8 + r() * 0.4, 59.9 + r() * 0.2, 1.5 + r() * 2.5)
  );
  return {
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid([...basin([21.8, 59.9, 22.2, 60.1], 20), ...rocks], {
      minZoom: 12,
      leafZoom: 16
    }),
    hazards: new HazardIndex([])
  };
}

/** Whether `p` lies in the convex ring, taken in Mercator, within `slack` metres. */
function inConvex(p: LonLat, ring: LonLat[], slack = 1e-6): boolean {
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

const index = rockField();
const origin: LonLat = [22.0, 60.0];

const navArb = fc.record({
  cog: uniform(0, 2 * Math.PI),
  sog: uniform(6, 9),
  rot: uniform(-0.03, 0.03)
});

test("an off-grid coarse footprint takes in every plan step it stands for", () => {
  const terms = vesselTerms(KEEL, { speed: 0, roll: undefined }, DEFAULT_DYNAMICS);
  const s: Scoring = {
    terms,
    threshold: thresholdDepth(terms, CHART_DATUM),
    sigmaExtra: sigmaExtra(terms, CHART_DATUM),
    sigmaPos: gnssSigma(undefined)
  };
  fc.assert(
    fc.property(navArb, (n) => {
      const m: Motion = {
        known: true,
        moving: true,
        cog: n.cog,
        sog: n.sog,
        rot: n.rot,
        heading: n.cog,
        horizon: opts.distance / n.sog,
        age: 0
      };
      const { times, step } = scheduleFor(m, KEEL, opts);
      expect(times.some((t) => Math.abs(t / step - Math.round(t / step)) > 1e-6)).toBe(true);
      const tracks = fanMembers(
        m.cog,
        m.sog,
        m.rot,
        { cog: opts.sigmaCog, rot: opts.sigmaRot },
        opts.turnFor
      );
      const score = (t: number, from?: number): FootprintResult =>
        footprint(t, origin, tracks, m, KEEL, index, s, opts, false, spanOf(from, step));
      // Coarse footprints from the warn window out to past the turn, and the plan steps between.
      for (let i = 1; i < times.length && (times[i - 1] as number) < 90; i++) {
        const from = times[i - 1] as number;
        const coarse = score(times[i] as number, from);
        for (let j = Math.floor(from / step + 1e-9) + 1; j * step <= coarse.t + 1e-9; j++) {
          const plan = score(j * step);
          expect(plan.ring.every((p) => inConvex(p, coarse.ring))).toBe(true);
          expect(coarse.risk).toBeGreaterThanOrEqual(plan.risk);
          expect(plan.flags & ~coarse.flags).toBe(0);
        }
      }
    }),
    { numRuns: 25, examples: [[{ cog: Math.PI / 2, sog: 7, rot: 0.02 }]] }
  );
});
