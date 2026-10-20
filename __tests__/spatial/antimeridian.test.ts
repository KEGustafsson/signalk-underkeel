import { offset } from "../../src/foundation/geo";
import { HazardIndex } from "../../src/spatial/hazards";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { geomBounds } from "../../src/foundation/geometry";
import type { Box } from "../helpers/synthetic";
import { basin, point } from "../helpers/synthetic";

// Two cells meeting at the antimeridian, both 20 m deep.
const WEST: Box = [179.9, -16.9, 180, -16.8];
const EAST: Box = [-180, -16.9, -179.9, -16.8];
const OPTS = { minZoom: 10, leafZoom: 17 };

function store(rockLon: number) {
  const rock = point(rockLon, -16.85, 0.5, { cellRef: rockLon < 0 ? 1 : 0 });
  return buildPyramid([...basin(WEST, 20), ...basin(EAST, 20, { cellRef: 1 }), rock], OPTS);
}

describe("queries across the antimeridian", () => {
  test("a buffer past 180° reaches a rock just east of it", () => {
    // The rock is ~107 m east of 180°, the vessel ~53 m west: ~160 m apart.
    const r = minDepthOver(store(-179.9995), footprintGeom([[179.9995, -16.85]]), {
      bufferMetres: 300
    });
    expect(r.dMin).toBe(0.5);
    expect(r.cellRefs).toContain(1);
  });

  test("a buffer past -180° reaches a rock just west of it", () => {
    const r = minDepthOver(store(179.9995), footprintGeom([[-179.9995, -16.85]]), {
      bufferMetres: 300
    });
    expect(r.dMin).toBe(0.5);
  });

  test("a footprint ring drawn past 180° reads the cell on the other side", () => {
    const from: [number, number] = [179.999, -16.85];
    const tip = offset(from, 500, 0);
    expect(tip[0]).toBeGreaterThan(180);
    const ring: [number, number][] = [
      [from[0], -16.8502],
      [tip[0], -16.8502],
      [tip[0], -16.8498],
      [from[0], -16.8498]
    ];
    const r = minDepthOver(store(-179.9995), footprintGeom(ring), { bufferMetres: 10 });
    expect(r.dMin).toBe(0.5);
  });

  test("a footprint wholly past 180° is the chart east of -180°, not empty", () => {
    const r = minDepthOver(store(-179.9995), footprintGeom([[180.05, -16.85]]));
    expect(r.dMin).toBe(20);
    expect(r.flags & FLAGS.NO_COVERAGE).toBe(0);
  });

  test("the hazard index names a rock on the other side of 180°", () => {
    const rock = point(-179.9995, -16.85, 0.5);
    const geom = footprintGeom([[179.9995, -16.85]]);
    const hits = new HazardIndex([rock]).near(geom, mercatorBuffer(geomBounds(geom), 300));
    expect(hits.map((h) => h.feature)).toEqual([rock]);
  });
});

describe("cells meeting at the antimeridian", () => {
  test("two cells meeting at ±180° cover the leaves on that edge", () => {
    for (const lon of [179.99999, -179.99999]) {
      const r = minDepthOver(store(179.95), footprintGeom([[lon, -16.85]]), { bufferMetres: 10 });
      expect(r.dMin).toBe(20);
      expect(r.flags).toBe(0);
    }
  });

  test("a cell ending at 180° with nothing past it still leaves a gap", () => {
    const west = buildPyramid(basin(WEST, 20), OPTS);
    const inside = minDepthOver(west, footprintGeom([[179.99999, -16.85]]));
    expect(inside.flags).toBe(0);
    const across = minDepthOver(west, footprintGeom([[179.99999, -16.85]]), { bufferMetres: 10 });
    expect(across.flags & FLAGS.NO_COVERAGE).toBeTruthy();
  });
});
