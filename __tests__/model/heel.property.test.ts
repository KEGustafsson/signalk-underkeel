import fc from "fast-check";
import { evaluateLookahead } from "../../src/engine/lookahead";
import type { HeelModel } from "../../src/model/allowances";
import { HazardIndex } from "../../src/spatial/hazards";
import { RISK_STOP_BELOW } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { CHART_DATUM, ctx } from "../helpers/engine";
import { basin } from "../helpers/synthetic";

/**
 * Safety invariant 2 with roll: whatever roll is published, a deeper
 * draft never lowers P(UKC < 0). The fin formula T·(cos φ − 1) breaks
 * this for |φ| > 90°.
 */

const NOW = 1_800_000_000_000;

describe("risk monotonicity in draft with roll (property)", () => {
  // From nearly drying to deep, so P is between 0 and 1 for some draft and roll.
  const indexes = [0.2, 1, 3].map((depth) => ({
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid(basin([22.0, 60.0, 22.04, 60.02], depth), { minZoom: 12, leafZoom: 16 }),
    hazards: new HazardIndex([])
  }));
  const keels: HeelModel[] = [
    { kind: "fin" },
    { kind: "none" },
    {
      kind: "table",
      points: [
        { heel: 0, delta: 0 },
        { heel: 0.3, delta: 0.2 },
        { heel: 0.6, delta: -0.1 }
      ]
    }
  ];

  test("a deeper draft never lowers P at any roll", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -31416, max: 31416 }),
        fc.integer({ min: 5, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        fc.constantFrom(...keels),
        fc.integer({ min: 0, max: indexes.length - 1 }),
        (roll, draft, more, keel, which) => {
          const index = indexes[which] as (typeof indexes)[number];
          const at = NOW;
          const nav = {
            position: { value: [22.02, 60.01] as [number, number], at },
            cog: { value: Math.PI / 2, at },
            sog: { value: 3, at },
            roll: { value: roll / 10000, at }
          };
          const risk = (d: number) =>
            evaluateLookahead(
              nav,
              ctx({ draft: d / 10, length: 10, beam: 3 }, CHART_DATUM, { heel: keel }),
              index,
              NOW
            ).risk ?? 0;
          expect(risk(draft + more)).toBeGreaterThanOrEqual(risk(draft) - RISK_STOP_BELOW);
        }
      ),
      { numRuns: 100 }
    );
  });
});
