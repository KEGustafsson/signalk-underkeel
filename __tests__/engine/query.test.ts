import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import { queryUkc } from "../../src/engine/query";
import type { LonLat } from "../../src/foundation/geo";
import { DEFAULT_DYNAMICS, vesselTerms } from "../../src/model/vessel";
import { parseQueryRequest } from "../../src/api/query-request";
import { CHART_DATUM } from "../helpers/engine";
import { BANK, fixtureIndex, ROCK } from "../helpers/fixture-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { area, coverage, quality } from "../helpers/synthetic";

const index = fixtureIndex();

function q(ring: LonLat[], draft: number, extra: { buffer?: number; degraded?: string } = {}) {
  return queryUkc(index, {
    ring,
    bufferMetres: extra.buffer ?? 0,
    terms: vesselTerms({ draft, length: 12, beam: 4 }, { speed: 0 }, DEFAULT_DYNAMICS),
    waterLevel: extra.degraded ? { ...CHART_DATUM, degraded: extra.degraded } : CHART_DATUM,
    thresholds: DEFAULT_LOOKAHEAD.thresholds
  });
}

describe("point and polygon UKC query", () => {
  test("on the rock a 3.6 m keel is danger, with the rock and the full explanation", () => {
    const r = q([ROCK], 3.6);
    expect(r.class).toBe("danger");
    expect(r.charted).toBe(3.5);
    expect(r.risk).toBeGreaterThan(0.5);
    expect(r.hazard).toMatchObject({ class: "UWTROC", lnam: "FI5-ROCK" });
    expect(r.explanation).toMatchObject({ charted: 3.5, draft: 3.6, squat: 0 });
    expect(r.sentence).toMatch(/^charted 3.5 m UWTROC FI5-ROCK/);
    expect(r.cells).toEqual([{ cell: "FI5SYNTH", edition: 3, update: 1 }]);
  });

  test("open water in the fairway is clear for a small draft", () => {
    const r = q([[22.006, 60.01]], 1.5);
    expect(r.class).toBe("clear");
    expect(r.mean).toBeCloseTo((r.charted as number) - 1.5, 6);
  });

  test("a buffer reaches the rock from beside it", () => {
    // ~111 m north: beyond the rock's ~76 m leaf tile and its burn disc.
    const beside: LonLat = [ROCK[0], ROCK[1] + 0.001];
    expect(q([beside], 3.6).class).toBe("clear");
    expect(q([beside], 3.6, { buffer: 150 }).class).toBe("danger");
  });

  test("a polygon over the CATZOC C bank takes its shoalest sounding", () => {
    const d = 0.001;
    const r = q(
      [
        [BANK[0] - d, BANK[1] - d],
        [BANK[0] + d, BANK[1] - d],
        [BANK[0] + d, BANK[1] + d],
        [BANK[0] - d, BANK[1] + d]
      ],
      1.5
    );
    expect(r.charted).toBe(1.8);
    expect(r.class).toBe("danger");
  });

  test("beyond coverage is unverified, never clear", () => {
    const r = q([[22.04, 60.01]], 1.5);
    expect(r.class).toBe("unverified");
    expect(r.flags).toContain("NO_COVERAGE");
  });

  test("against a fallback water level nothing is clear", () => {
    const r = q([[22.006, 60.01]], 1.5, { degraded: "water level from fmi is 40 min old" });
    expect(r.class).toBe("unverified");
    expect(r.waterLevelDegraded).toBe("water level from fmi is 40 min old");
  });
});

describe("query request validation", () => {
  test("a point, a closed polygon and the optional fields are read", () => {
    expect(
      parseQueryRequest({ geometry: { type: "Point", coordinates: [22, 60] }, draft: 2 })
    ).toEqual({ ok: true, value: { ring: [[22, 60]], draft: 2 } });
    const square = [
      [22, 60],
      [22.01, 60],
      [22.01, 60.01],
      [22, 60]
    ];
    const p = parseQueryRequest({
      geometry: { type: "Polygon", coordinates: [square] },
      bufferMetres: 10,
      speed: 3
    });
    expect(p).toEqual({
      ok: true,
      value: { ring: square.slice(0, 3), bufferMetres: 10, speed: 3 }
    });
  });

  test("malformed or oversized input is refused with reasons", () => {
    const bad = (body: unknown) => {
      const r = parseQueryRequest(body);
      return r.ok ? [] : r.errors;
    };
    expect(bad({})).toEqual(["geometry must be a GeoJSON Point or Polygon"]);
    expect(bad({ geometry: { type: "Point", coordinates: [200, 60] } })).toEqual([
      "point must be [lon, lat] within ±180 / ±85"
    ]);
    expect(bad({ geometry: { type: "Polygon", coordinates: [[[22, 60]]] } })[0]).toMatch(
      /4\.\.500/
    );
    expect(
      bad({ geometry: { type: "Point", coordinates: [22, 60] }, bufferMetres: -1, draft: 0 })
    ).toEqual(["bufferMetres must be 0..2000", "draft must be 0.1..30"]);
    const box = (w: number, s: number, e: number, n: number) => ({
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s]
          ]
        ]
      }
    });
    expect(bad(box(-180, -85, 180, 85))).toEqual(["polygon must fit in a box 50 km across"]);
    expect(bad(box(-179.9, 60, 179.9, 60.01))).toEqual(["polygon must fit in a box 50 km across"]);
    expect(bad(box(22, 60, 22.05, 60.02))).toEqual([]);
    // About 17 × 22 km: inside the 50 km box, but too much area for one query.
    expect(bad(box(22, 60, 22.3, 60.2))).toEqual(["geometry and buffer must fit in 25 km²"]);
    expect(bad({ geometry: { type: "Point", coordinates: [22, 60] }, bufferMetres: 2000 })).toEqual(
      []
    );
    expect(bad({ ...box(22, 60, 22.05, 60.02), bufferMetres: 2000 })).toEqual([
      "geometry and buffer must fit in 25 km²"
    ]);
    const holed = box(22, 60, 22.3, 60.2);
    holed.geometry.coordinates.push([
      [22.1, 60.1],
      [22.2, 60.1],
      [22.2, 60.15],
      [22.1, 60.1]
    ]);
    expect(bad(holed)).toEqual(["polygon holes are not supported"]);
    const open = box(22, 60, 22.3, 60.2);
    open.geometry.coordinates[0]?.pop();
    expect(bad(open)).toEqual(["polygon outer ring must be closed"]);
  });

  test("a polygon is refused when its vertices times its box and buffer area are too much work", () => {
    const circle = (vertices: number, radius: number) => {
      const ring = Array.from({ length: vertices }, (_, i) => {
        const a = (2 * Math.PI * i) / vertices;
        return [
          22.085 + (radius * Math.sin(a)) / (111195 * Math.cos((60.075 * Math.PI) / 180)),
          60.075 + (radius * Math.cos(a)) / 111195
        ];
      });
      return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
    };
    const errors = (body: unknown) => {
      const r = parseQueryRequest(body);
      return r.ok ? [] : r.errors;
    };
    // 499 vertices over (1 + 4 km)² fits the 25 km² box limit and took 0.47 s on a laptop.
    expect(errors({ geometry: circle(499, 490), bufferMetres: 2000 })).toEqual([
      "polygon vertices × km² of box and buffer must be at most 150: use fewer vertices or a smaller buffer"
    ]);
    expect(errors({ geometry: circle(5, 490), bufferMetres: 2000 })).toEqual([]);
    expect(errors({ geometry: circle(499, 270) })).toEqual([]);
    expect(
      errors({ geometry: { type: "Point", coordinates: [22, 60] }, bufferMetres: 2000 })
    ).toEqual([]);
  });
});

describe("chart position uncertainty", () => {
  test("a drying area 40 m away under CATZOC B (±50 m) is in reach of a point query", () => {
    const box = [22.0, 60.0, 22.06, 60.03] as const;
    const north = 40 / 111195;
    const charted = {
      catalogue: { version: 1 as const, cells: [] },
      pyramid: buildPyramid(
        [
          coverage(box),
          quality(box, 3),
          area(box, 15),
          area([22.028, 60.015 + north, 22.032, 60.016 + north], -1)
        ],
        { minZoom: 12, leafZoom: 20 }
      ),
      hazards: new HazardIndex([])
    };
    const r = queryUkc(charted, {
      ring: [[22.03, 60.015]],
      bufferMetres: 0,
      terms: vesselTerms({ draft: 1.8, length: 12, beam: 4 }, { speed: 0 }, DEFAULT_DYNAMICS),
      waterLevel: CHART_DATUM,
      thresholds: DEFAULT_LOOKAHEAD.thresholds
    });
    expect(r.charted).toBe(-1);
    expect(r.class).toBe("danger");
  });
});
