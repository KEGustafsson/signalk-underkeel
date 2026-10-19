import { buildEnvelope } from "../../src/engine/envelope";
import type { NavState } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import { reduce } from "../../src/livechart/soundings";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { CHART_DATUM, ctx } from "../helpers/engine";
import type { Box } from "../helpers/synthetic";
import { basin } from "../helpers/synthetic";

/**
 * Positions the engine returns or stores are canonical WGS84, longitude in
 * [-180, 180] (RFC 7946 §3.1.9), however close to the antimeridian the boat
 * is; footprint rings for the query alone may run past it.
 */

const WEST: Box = [179.97, -16.9, 180, -16.8];
const EAST: Box = [-180, -16.9, -179.97, -16.8];
const NOW = 1_800_000_000_000;

function chart(): ChartIndex {
  return {
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid([...basin(WEST, 10), ...basin(EAST, 10, { cellRef: 1 })], {
      minZoom: 10,
      leafZoom: 18
    }),
    hazards: new HazardIndex([])
  };
}

function lons(value: unknown): number[] {
  if (Array.isArray(value) && typeof value[0] === "number") {
    return [value[0] as number];
  }
  return Array.isArray(value) ? value.flatMap(lons) : [];
}

const canonical = (lon: number): boolean => lon >= -180 && lon <= 180;

describe("positions across the antimeridian", () => {
  test("the envelope is canonical and cut at 180°", () => {
    const at = NOW;
    const nav: NavState = {
      position: { value: [179.999, -16.85], at },
      cog: { value: Math.PI / 2, at },
      sog: { value: 3, at },
      heading: { value: Math.PI / 2, at }
    };
    const r = evaluateLookahead(nav, ctx({ draft: 1.5, length: 12, beam: 4 }), chart(), NOW);
    expect(r.footprints.some((f) => f.center[0] > 180)).toBe(true);
    const env = buildEnvelope(r, DEFAULT_LOOKAHEAD.thresholds);
    for (const f of env.features) {
      expect(lons(f.geometry.coordinates).every(canonical)).toBe(true);
    }
    // The track is cut in two at the antimeridian, meeting at the same latitude.
    const tracks = env.features.filter((f) => f.properties.kind === "track");
    expect(tracks).toHaveLength(2);
    const [west, east] = tracks.map((t) => t.geometry.coordinates as number[][]);
    expect(west?.[west.length - 1]).toEqual([180, expect.any(Number)]);
    expect(east?.[0]).toEqual([-180, west?.[west.length - 1]?.[1]]);
    // No segment polygon spans the world.
    for (const f of env.features.filter((x) => x.properties.kind === "segment")) {
      const xs = lons(f.geometry.coordinates);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1);
    }
  });

  test("a transducer forward of the antenna across 180° stores a canonical position", () => {
    const r = reduce(
      {
        depth: 5,
        at: NOW,
        position: [179.99999, -16.85],
        positionAt: NOW,
        heading: Math.PI / 2,
        hdop: 1,
        methodQuality: "GNSS Fix",
        waterLevel: CHART_DATUM
      },
      { path: "environment.depth.belowSurface", transducerDepth: 0, forward: 5, starboard: 0 }
    );
    expect(r.ok).toBe(true);
    const lon = r.ok ? r.sounding.position[0] : NaN;
    expect(lon).toBeGreaterThan(-180);
    expect(lon).toBeLessThan(-179.9999);
  });
});
