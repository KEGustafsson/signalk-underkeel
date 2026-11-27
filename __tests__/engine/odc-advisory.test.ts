import fs from "fs";
import os from "os";
import path from "path";
import { evaluateLookahead } from "../../src/engine/lookahead";
import type { NavState } from "../../src/engine/lookahead";
import { checkRoute } from "../../src/engine/route-check";
import { classify } from "../../src/engine/ukc-tiles";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import {
  ODC_CELL_NAME,
  ODC_NOTICE,
  tileBbox,
  writeOdcCell,
  writeStagedTile
} from "../../src/ingest/odc";
import { writeCell } from "../../src/ingest/wfs";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { buildChartIndex } from "../../src/spatial/chart-index";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { CHART_DATUM, ctx } from "../helpers/engine";
import type { LonLatPoint } from "../helpers/mvt-encode";
import { encodeTile } from "../helpers/mvt-encode";

/**
 * An Open Data Charts cell over two z15 tiles: 10 m on the west tile, 4 m on the east one,
 * and an ENC cell over part of the west tile. The charts are not for navigation, so nothing
 * they alone cover may read as safe, as for the Traficom WFS (plan §4.2).
 */

const WEST = { z: 15, x: 15920, y: 11414 };
const EAST = { z: 15, x: 15921, y: 11414 };
const [W, S, , N] = tileBbox(WEST);
const [, , E] = tileBbox(EAST);
const NOW = 1_800_000_000_000;
const KEEL = { draft: 2, length: 12, beam: 4 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-odc-advisory-"));

const lon = (f: number): number => W + (E - W) * f;
const lat = (f: number): number => S + (N - S) * f;
const ENC_BOX = [lon(0.1), lat(0.6), lon(0.3), lat(0.9)] as const;

function square([w, s, e, n]: readonly number[]): LonLatPoint[] {
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s]
  ] as LonLatPoint[];
}

function feature(geometry: unknown, properties: Record<string, unknown>) {
  return { type: "Feature" as const, geometry: geometry as never, properties };
}

function encCell(dir: string): void {
  const area = { type: "Polygon", coordinates: [square(ENC_BOX)] };
  writeCell(dir, {
    DSID: { type: "FeatureCollection", features: [feature(null, { DSID_DSNM: "FR5ENC01.000" })] },
    M_COVR: { type: "FeatureCollection", features: [feature(area, { CATCOV: 1 })] },
    M_QUAL: { type: "FeatureCollection", features: [feature(area, { CATZOC: 1 })] },
    DEPARE: { type: "FeatureCollection", features: [feature(area, { DRVAL1: 10 })] }
  } as never);
}

function odcCell(dir: string): void {
  const tiles = path.join(TMP, "odc-tiles.bin");
  const fd = fs.openSync(tiles, "w");
  for (const [id, depth] of [
    [WEST, 10],
    [EAST, 4]
  ] as const) {
    const [w, s, e, n] = tileBbox(id);
    const pad = (e - w) / 20;
    writeStagedTile(fd, {
      ...id,
      data: encodeTile(id, {
        DEPARE: [
          {
            polygon: [[square([w - pad, s - pad, e + pad, n + pad])]],
            properties: { DRVAL1: depth, DRVAL2: depth + 5 }
          }
        ]
      })
    });
  }
  fs.closeSync(fd);
  writeOdcCell({ tiles, dir, bbox: [W, S, E, N], now: new Date(NOW).toISOString(), catzoc: 4 });
}

function build(): ChartIndex {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const odcDir = path.join(TMP, ODC_CELL_NAME);
  odcCell(odcDir);
  const encDir = path.join(TMP, "FR5ENC01");
  encCell(encDir);
  return buildChartIndex([readCellDirectory(encDir, 0), readCellDirectory(odcDir, 1)], {
    minZoom: 12,
    leafZoom: 18
  });
}

const at = (index: ChartIndex, x: number, y: number) =>
  minDepthOver(index.pyramid, footprintGeom([[lon(x), lat(y)]]));

function nav(x: number, y: number, cog: number, sog: number): NavState {
  return {
    position: { value: [lon(x), lat(y)], at: NOW },
    cog: { value: cog, at: NOW },
    sog: { value: sog, at: NOW },
    heading: { value: cog, at: NOW }
  };
}

describe("Open Data Charts depths are advisory", () => {
  const index = build();
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  test("ODC water is flagged not for navigation; ENC water is not flagged", () => {
    const water = at(index, 0.25, 0.3);
    expect(water.dMin).toBe(10);
    expect(water.flags & FLAGS.NOT_FOR_NAVIGATION).toBeTruthy();
    const shoal = at(index, 0.75, 0.5);
    expect(shoal.dMin).toBe(4);
    expect(shoal.flags & FLAGS.NOT_FOR_NAVIGATION).toBeTruthy();
    const enc = at(index, 0.2, 0.75);
    expect(enc.cellRef).toBe(0);
    expect(enc.flags & (FLAGS.NOT_FOR_NAVIGATION | FLAGS.UNASSESSED)).toBe(0);
  });

  test("the look-ahead over ODC water is alert with its notice, never normal", () => {
    const r = evaluateLookahead(nav(0.25, 0.3, 0, 0), ctx(KEEL), index, NOW);
    expect(r.state).toBe("alert");
    expect(r.reason).toBe(ODC_NOTICE);
    expect(evaluateLookahead(nav(0.2, 0.75, 0, 0), ctx(KEEL), index, NOW).state).toBe("normal");
  });

  test("a route leg over ODC water is unverified, never ok", () => {
    const r = checkRoute(
      index,
      {
        coordinates: [
          [lon(0.05), lat(0.3)],
          [lon(0.4), lat(0.3)]
        ],
        departure: NOW,
        speeds: [2.5],
        xteLimit: 30,
        hullBuffer: 10,
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

  test("the overlay never draws ODC water as clear", () => {
    const water = at(index, 0.25, 0.3);
    const input = {
      threshold: 2,
      sigmaExtra: 0.3,
      thresholds: { alert: 0.01, warn: 0.05, alarm: 0.2 },
      degraded: false
    };
    expect(classify({ ...water, flags: water.flags & ~FLAGS.UNASSESSED }, input)).toBe(
      "unverified"
    );
  });
});

describe("Open Data Charts dredged and swept areas", () => {
  const dir = path.join(TMP, "dredged", ODC_CELL_NAME);
  const tiles = path.join(TMP, "dredged-tiles.bin");
  const [w, s, e, n] = tileBbox(WEST);
  const frac = (fx: number, fy: number): LonLatPoint => [w + (e - w) * fx, s + (n - s) * fy];
  const part = (fw: number, fe: number): LonLatPoint[] => [
    frac(fw, 0.2),
    frac(fe, 0.2),
    frac(fe, 0.8),
    frac(fw, 0.8),
    frac(fw, 0.2)
  ];
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const fd = fs.openSync(tiles, "w");
  writeStagedTile(fd, {
    ...WEST,
    data: encodeTile(WEST, {
      DEPARE: [{ polygon: [[square([w, s, e, n])]], properties: { DRVAL1: 0, DRVAL2: 2 } }],
      DRGARE: [{ polygon: [[part(0.1, 0.4)]], properties: { DRVAL1: 5 } }],
      SWPARE: [{ polygon: [[part(0.6, 0.9)]], properties: { DRVAL1: 5 } }]
    })
  });
  fs.closeSync(fd);
  writeOdcCell({ tiles, dir, bbox: [w, s, e, n], now: new Date(NOW).toISOString(), catzoc: 4 });
  const index = buildChartIndex([readCellDirectory(dir, 0)], { minZoom: 12, leafZoom: 18 });
  const over = (fx: number) =>
    minDepthOver(index.pyramid, footprintGeom([[w + (e - w) * fx, s + (n - s) * 0.5]]));

  test("only add caution: the depth area under them still reads, with no dredged or swept guarantee", () => {
    for (const fx of [0.25, 0.75]) {
      const leaf = over(fx);
      expect(leaf.dMin).toBe(0);
      expect(leaf.flags & (FLAGS.DREDGED | FLAGS.SWEPT)).toBe(0);
      expect(leaf.sigmaD).toBeGreaterThan(0.1);
    }
  });
});
