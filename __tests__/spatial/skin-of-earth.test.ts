import { checkRoute } from "../../src/engine/route-check";
import { evaluateLookahead } from "../../src/engine/lookahead";
import type { LonLat } from "../../src/foundation/geo";
import type { GeoJsonFeatureCollection, S57Layer } from "../../src/ingest/s57-geojson";
import { parseLayer, S57_LAYERS } from "../../src/ingest/s57-geojson";
import type { ChartFeature } from "../../src/ingest/features";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import { CHART_DATUM, ctx } from "../helpers/engine";

const CTX = { cellRef: 0, band: 5 };
const rect = (w: number, s: number, e: number, n: number) => ({
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
});
const fc = (
  geometry: object,
  properties: Record<string, unknown> = {}
): GeoJsonFeatureCollection => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: geometry as never, properties }]
});

/**
 * A CATZOC C cell: DEPARE 10 m over the west half and a 12 m sounding
 * just west of the middle, whose 500 m burn disc reaches the east half.
 * `east` is the skin-of-earth object charted over the east half, if any.
 */
function cell(east?: S57Layer): ChartFeature[] {
  const f = [
    ...parseLayer("M_COVR", fc(rect(22.0, 60.0, 22.02, 60.01), { CATCOV: 1 }), CTX),
    ...parseLayer("M_QUAL", fc(rect(22.0, 60.0, 22.02, 60.01), { CATZOC: 4 }), CTX),
    ...parseLayer("DEPARE", fc(rect(22.0, 60.0, 22.01, 60.01), { DRVAL1: 10, DRVAL2: 20 }), CTX),
    ...parseLayer("SOUNDG", fc({ type: "Point", coordinates: [22.0095, 60.005, 12] }), CTX)
  ];
  return east ? [...f, ...parseLayer(east, fc(rect(22.01, 60.0, 22.02, 60.01)), CTX)] : f;
}

const OPTS = { minZoom: 12, leafZoom: 18 };
const EAST_LONS = [22.0115, 22.015, 22.019];

function at(store: ReturnType<typeof buildPyramid>, lon: number) {
  const d = 0.0002;
  return minDepthOver(
    store,
    footprintGeom([
      [lon - d, 60.005 - d],
      [lon + d, 60.005 - d],
      [lon + d, 60.005 + d],
      [lon - d, 60.005 + d]
    ])
  );
}

describe("skin-of-earth objects without a depth", () => {
  test("the index reads every skin-of-earth class", () => {
    for (const layer of ["PONTON", "FLODOC", "HULKES", "UNSARE"]) {
      expect(S57_LAYERS).toContain(layer);
    }
  });

  test.each(["PONTON", "FLODOC", "HULKES"] as const)("%s is land", (layer) => {
    const store = buildPyramid(cell(layer), OPTS);
    for (const lon of EAST_LONS) {
      const r = at(store, lon);
      expect(r.dMin).toBe(-Infinity);
      expect(r.coveredDMin).toBe(-Infinity);
    }
    expect(at(store, 22.005).dMin).toBe(10);
  });

  test.each([
    ["an unsurveyed area", "UNSARE" as const],
    ["a covered area with no depth area", undefined]
  ])("%s has no depth, whatever sounding reaches it", (_, layer) => {
    const store = buildPyramid(cell(layer), OPTS);
    for (const lon of EAST_LONS) {
      const r = at(store, lon);
      expect(r.dMin).toBe(-Infinity);
      expect(r.coveredDMin).not.toBe(12);
      expect(r.flags & FLAGS.NO_COVERAGE).toBeTruthy();
      expect(r.flags & FLAGS.NO_DEPTH).toBeTruthy();
    }
    expect(at(store, 22.005)).toMatchObject({ dMin: 10, flags: 0 });
  });

  describe("an unsurveyed area in the engine", () => {
    const NOW = Date.parse("2026-10-18T07:00:00Z");
    const index: ChartIndex = {
      catalogue: { version: 1, cells: [] },
      pyramid: buildPyramid(cell("UNSARE"), OPTS),
      hazards: new HazardIndex([])
    };

    test("a route leg across it is unverified", () => {
      const coordinates: LonLat[] = [
        [22.012, 60.005],
        [22.018, 60.005]
      ];
      const r = checkRoute(
        index,
        {
          coordinates,
          departure: NOW,
          speeds: [2.5],
          xteLimit: 20,
          planningBuffer: 10,
          vessel: { draft: 1.5, length: 12, beam: 4 },
          dynamics: DEFAULT_DYNAMICS,
          waterLevel: () => CHART_DATUM,
          probability: 0.01
        },
        NOW
      );
      expect(r.legs[0]?.status).toBe("unverified");
    });

    test("the look-ahead inside it is never normal", () => {
      const nav = {
        position: { value: [22.015, 60.005] as LonLat, at: NOW },
        cog: { value: Math.PI / 2, at: NOW },
        sog: { value: 2, at: NOW },
        heading: { value: Math.PI / 2, at: NOW }
      };
      const r = evaluateLookahead(nav, ctx({ draft: 1.5, length: 12, beam: 4 }), index, NOW);
      expect(r.state).not.toBe("normal");
    });
  });
});
