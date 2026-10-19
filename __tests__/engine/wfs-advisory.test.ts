import fs from "fs";
import path from "path";
import { evaluateLookahead } from "../../src/engine/lookahead";
import type { NavState } from "../../src/engine/lookahead";
import { checkRoute } from "../../src/engine/route-check";
import { classify } from "../../src/engine/ukc-tiles";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { Bbox } from "../../src/ingest/wfs";
import { toCellLayers, WFS_NOTICE, writeCell } from "../../src/ingest/wfs";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { buildChartIndex } from "../../src/spatial/chart-index";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { CHART_DATUM, ctx } from "../helpers/engine";

/**
 * A Traficom WFS box (plan §4.2): depth areas on the west half, nothing on
 * the east half, and an ENC cell over part of the west half. The WFS lacks
 * rocks and survey quality, so nothing it alone covers may read as safe.
 */

const BOX: Bbox = [22.0, 60.0, 22.02, 60.01];
const ENC_BOX = [22.002, 60.006, 22.006, 60.009] as const;
const NOW = 1_800_000_000_000;
const KEEL = { draft: 2, length: 12, beam: 4 };
const TMP = path.join(__dirname, "..", "temp", "wfs-advisory");

function square([w, s, e, n]: readonly number[]) {
  return [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s]
    ]
  ];
}

function feature(geometry: unknown, properties: Record<string, unknown>) {
  return { type: "Feature" as const, geometry: geometry as never, properties };
}

function encCell(dir: string): void {
  const layers = {
    DSID: { type: "FeatureCollection", features: [feature(null, { DSID_DSNM: "FI5ENC01.000" })] },
    M_COVR: {
      type: "FeatureCollection",
      features: [feature({ type: "Polygon", coordinates: square(ENC_BOX) }, { CATCOV: 1 })]
    },
    M_QUAL: {
      type: "FeatureCollection",
      features: [feature({ type: "Polygon", coordinates: square(ENC_BOX) }, { CATZOC: 1 })]
    },
    DEPARE: {
      type: "FeatureCollection",
      features: [feature({ type: "Polygon", coordinates: square(ENC_BOX) }, { DRVAL1: 10 })]
    }
  };
  writeCell(dir, layers as never);
}

function build(): ChartIndex {
  fs.rmSync(TMP, { recursive: true, force: true });
  const wfsDir = path.join(TMP, "FI1WFS01");
  writeCell(
    wfsDir,
    toCellLayers(
      {
        // Two areas meeting at 60.004° N whose shared edge has different vertices on each side.
        depthAreas: [
          feature(
            { type: "Polygon", coordinates: square([21.99, 59.99, 22.01, 60.004]) },
            { DRVAL1: "10", DRVAL2: "15", IDENTIFIER: "FI 1" }
          ),
          feature(
            {
              type: "Polygon",
              coordinates: [
                [
                  [21.99, 60.004],
                  [22.0, 60.004],
                  [22.01, 60.004],
                  [22.01, 60.02],
                  [21.99, 60.02],
                  [21.99, 60.004]
                ]
              ]
            },
            { DRVAL1: "6", DRVAL2: "10", IDENTIFIER: "FI 2" }
          )
        ],
        dredgedAreas: [],
        soundings: [feature({ type: "Point", coordinates: [22.004, 60.003, 0] }, { DEPTH: 12 })]
      },
      BOX,
      new Date(NOW)
    )
  );
  const encDir = path.join(TMP, "FI5ENC01");
  encCell(encDir);
  return buildChartIndex([readCellDirectory(encDir, 0), readCellDirectory(wfsDir, 1)], {
    minZoom: 12,
    leafZoom: 18
  });
}

function at(index: ChartIndex, lon: number, lat: number) {
  return minDepthOver(index.pyramid, footprintGeom([[lon, lat]]));
}

function nav(lon: number, lat: number, cog: number, sog: number): NavState {
  return {
    position: { value: [lon, lat], at: NOW },
    cog: { value: cog, at: NOW },
    sog: { value: sog, at: NOW },
    heading: { value: cog, at: NOW }
  };
}

describe("Traficom WFS depths are advisory", () => {
  const index = build();
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  test("the cell is read as band 1 with its source", () => {
    expect(index.catalogue.cells[1]).toMatchObject({
      name: "FI1WFS01",
      band: 1,
      source: "traficom-wfs"
    });
  });

  test("WFS water is flagged; water without a depth area is land; ENC water is not flagged", () => {
    const water = at(index, 22.004, 60.002);
    expect(water.dMin).toBe(10);
    expect(water.flags & FLAGS.NOT_FOR_NAVIGATION).toBeTruthy();
    expect(water.flags & FLAGS.UNASSESSED).toBeTruthy();
    const seam = at(index, 22.004, 60.004);
    expect(seam.dMin).toBe(6);
    const gap = at(index, 22.015, 60.005);
    expect(gap.dMin).toBe(-Infinity);
    expect(gap.flags & FLAGS.NOT_FOR_NAVIGATION).toBeTruthy();
    expect(gap.flags & FLAGS.NO_DEPTH).toBe(0);
    const enc = at(index, 22.004, 60.0075);
    expect(enc.dMin).toBe(10);
    expect(enc.cellRef).toBe(0);
    expect(enc.flags & (FLAGS.NOT_FOR_NAVIGATION | FLAGS.UNASSESSED)).toBe(0);
  });

  test("the look-ahead over WFS water is alert with the notice, never normal", () => {
    const r = evaluateLookahead(nav(22.004, 60.001, 0, 0), ctx(KEEL), index, NOW);
    expect(r.state).toBe("alert");
    expect(r.reason).toBe(WFS_NOTICE);
    const enc = evaluateLookahead(nav(22.004, 60.0075, 0, 0), ctx(KEEL), index, NOW);
    expect(enc.state).toBe("normal");
  });

  test("heading into water the WFS leaves out raises the alarm", () => {
    const r = evaluateLookahead(nav(22.0095, 60.003, Math.PI / 2, 3), ctx(KEEL), index, NOW);
    expect(r.state).toBe("alarm");
  });

  test("a route leg over WFS water is unverified, never ok", () => {
    const r = checkRoute(
      index,
      {
        coordinates: [
          [22.003, 60.001],
          [22.008, 60.001]
        ],
        departure: NOW,
        speeds: [2.5],
        xteLimit: 30,
        planningBuffer: 10,
        vessel: KEEL,
        dynamics: DEFAULT_DYNAMICS,
        waterLevel: () => CHART_DATUM,
        probability: 0.01
      },
      NOW
    );
    expect(r.legs[0]?.status).toBe("unverified");
    expect(r.legs[0]?.flags).toContain("NOT_FOR_NAVIGATION");
  });

  test("the overlay never draws WFS water as clear", () => {
    const water = at(index, 22.004, 60.002);
    const input = {
      threshold: 2,
      sigmaExtra: 0.3,
      thresholds: { alert: 0.01, warn: 0.05, alarm: 0.2 },
      degraded: false
    };
    expect(classify({ ...water, flags: water.flags & ~FLAGS.UNASSESSED }, input)).toBe(
      "unverified"
    );
    expect(classify({ ...water, dMin: 10, flags: 0 }, input)).toBe("clear");
  });
});
