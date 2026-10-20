import fc from "fast-check";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import type { Catzoc } from "../../src/ingest/features";
import { RISK_STOP_BELOW, footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { fraction, uniform } from "../helpers/arbitraries";
import { ctx } from "../helpers/engine";
import { fixtureIndex } from "../helpers/fixture-index";
import type { Box } from "../helpers/synthetic";
import { area, boxRing, coverage, point, quality } from "../helpers/synthetic";

/**
 * Safety invariant 2 (AGENTS.md, plan §7): a deeper draft, a lower water
 * level or a larger position uncertainty never lowers P(UKC < 0). The
 * pyramid's early stop may overstate a footprint's P by up to
 * RISK_STOP_BELOW, so comparisons allow that slack.
 */

const W = 22.0;
const S = 60.0;
const DOMAIN: Box = [W, S, W + 0.02, S + 0.01];
const box = fc.tuple(fraction, fraction, fraction, fraction).map(([a, b, c, d]): Box => {
  const lon0 = W + Math.min(a, b) * 0.02;
  const lat0 = S + Math.min(c, d) * 0.01;
  return [lon0, lat0, W + Math.max(a, b) * 0.02 + 1e-5, S + Math.max(c, d) * 0.01 + 1e-5];
});

const chart = fc.record({
  zones: fc.array(fc.tuple(box, fc.integer({ min: 1, max: 6 })), { minLength: 1, maxLength: 3 }),
  areas: fc.array(fc.tuple(box, uniform(0, 15)), { maxLength: 3 }),
  points: fc.array(fc.tuple(fraction, fraction, uniform(0, 10)), {
    maxLength: 4
  })
});

interface ChartSpec {
  zones: [Box, number][];
  areas: [Box, number][];
  points: [number, number, number][];
}

function build(c: ChartSpec) {
  return buildPyramid(
    [
      coverage(DOMAIN),
      area(DOMAIN, 20),
      ...c.zones.map(([b, z]) => quality(b, z as Catzoc)),
      ...c.areas.map(([b, d]) => area(b, d)),
      ...c.points.map(([x, y, d]) => point(W + x * 0.02, S + y * 0.01, d))
    ],
    { minZoom: 13, leafZoom: 17 }
  );
}

describe("risk monotonicity (property)", () => {
  test("a higher UKC-zero depth (deeper draft, lower water) never lowers P", () => {
    fc.assert(
      fc.property(chart, box, uniform(0, 15), uniform(0, 3), uniform(0, 1), (c, q, t1, dt, sx) => {
        const store = build(c);
        const geom = footprintGeom(boxRing(q));
        const r1 = minDepthOver(store, geom, { risk: { threshold: t1, sigmaExtra: sx } });
        const r2 = minDepthOver(store, geom, { risk: { threshold: t1 + dt, sigmaExtra: sx } });
        expect(r2.maxRisk).toBeGreaterThanOrEqual(r1.maxRisk - RISK_STOP_BELOW);
      }),
      { numRuns: 100 }
    );
  });

  test("a larger position buffer never lowers P", () => {
    fc.assert(
      fc.property(
        chart,
        box,
        uniform(0, 50),
        uniform(0, 100),
        uniform(0, 12),
        (c, q, b1, db, t) => {
          const store = build(c);
          const geom = footprintGeom(boxRing(q));
          const risk = { threshold: t, sigmaExtra: 0.3 };
          const r1 = minDepthOver(store, geom, { bufferMetres: b1, risk });
          const r2 = minDepthOver(store, geom, { bufferMetres: b1 + db, risk });
          expect(r2.maxRisk).toBeGreaterThanOrEqual(r1.maxRisk - RISK_STOP_BELOW);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("the look-ahead's P never falls with deeper draft, lower water, a larger buffer or σ_pos", () => {
    const index = fixtureIndex();
    const NOW = 1_800_000_000_000;
    fc.assert(
      fc.property(
        uniform(22.002, 22.033),
        uniform(60.001, 60.019),
        uniform(0, 2 * Math.PI),
        uniform(0.5, 4),
        uniform(0.5, 4),
        uniform(0, 1),
        uniform(0, 20),
        (lon, lat, cog, sog, draft, more, buffer) => {
          const nav = {
            position: { value: [lon, lat] as const, at: NOW },
            cog: { value: cog, at: NOW },
            sog: { value: sog, at: NOW },
            rot: { value: ((more - 0.5) * Math.PI) / 180, at: NOW }
          };
          const vessel = { draft, length: 10, beam: 3 };
          const wl = { h: 0, sigma: 0.2, source: "manual" };
          const base = evaluateLookahead(nav, ctx(vessel, wl), index, NOW).risk ?? 0;
          const deeper = evaluateLookahead(
            nav,
            ctx({ ...vessel, draft: draft + more }, wl),
            index,
            NOW
          );
          const lower = evaluateLookahead(nav, ctx(vessel, { ...wl, h: -more }), index, NOW);
          const opts = (b: number) => ({ ...DEFAULT_LOOKAHEAD, positionBuffer: b });
          const narrow =
            evaluateLookahead(nav, ctx(vessel, wl), index, NOW, opts(buffer)).risk ?? 0;
          const wide =
            evaluateLookahead(nav, ctx(vessel, wl), index, NOW, opts(buffer + 10 * more)).risk ?? 0;
          expect(deeper.risk ?? 0).toBeGreaterThanOrEqual(base - RISK_STOP_BELOW);
          expect(lower.risk ?? 0).toBeGreaterThanOrEqual(base - RISK_STOP_BELOW);
          expect(wide).toBeGreaterThanOrEqual(narrow - RISK_STOP_BELOW);
          const sigmaPos = (sp: number) => ({ ...ctx(vessel, wl), positionSigma: sp });
          const sure = evaluateLookahead(nav, sigmaPos(buffer / 2), index, NOW).risk ?? 0;
          const unsure =
            evaluateLookahead(nav, sigmaPos(buffer / 2 + 10 * more), index, NOW).risk ?? 0;
          expect(unsure).toBeGreaterThanOrEqual(sure - RISK_STOP_BELOW);
        }
      ),
      { numRuns: 30 }
    );
  });
});
