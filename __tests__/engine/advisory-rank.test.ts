import fs from "fs";
import os from "os";
import path from "path";
import { evaluateLookahead } from "../../src/engine/lookahead";
import type { NavState } from "../../src/engine/lookahead";
import { checkRoute } from "../../src/engine/route-check";
import type { ReadCell } from "../../src/ingest/cell-reader";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import { ODC_NOTICE, tileBbox, writeOdcCell, writeStagedTile } from "../../src/ingest/odc";
import type { Bbox } from "../../src/ingest/wfs";
import { toCellLayers, WFS_NOTICE, writeCell } from "../../src/ingest/wfs";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { buildChartIndex } from "../../src/spatial/chart-index";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { CHART_DATUM, ctx } from "../helpers/engine";
import type { LonLatPoint } from "../helpers/mvt-encode";
import { encodeTile } from "../helpers/mvt-encode";

/**
 * Advisory cells (Traficom WFS, Open Data Charts) rank below every official ENC cell, band 1
 * overview cells included (plan §4.2): where an ENC cell covers, its depths alone decide and
 * nothing is flagged; where only advisory cells cover, the shallowest of them is read, flagged.
 */

const TILE = { z: 15, x: 15920, y: 11414 };
const [W, S, E, N] = tileBbox(TILE);
const NOW = 1_800_000_000_000;
const KEEL = { draft: 2, length: 12, beam: 4 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-advisory-rank-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const lon = (f: number): number => W + (E - W) * f;
const lat = (f: number): number => S + (N - S) * f;
/** The ENC cell covers the west half of the tile. */
const ENC_BOX: Bbox = [lon(0), lat(0), lon(0.5), lat(1)];
const ENC_DEPTH = 12;
const ODC_DEPTH = 4;
const WFS_DEPTH = 6;

function ring([w, s, e, n]: readonly number[]): LonLatPoint[] {
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

/** A band-1 overview ENC cell over `ENC_BOX`. */
function encCell(): ReadCell {
  const dir = path.join(TMP, "FR1ENC01");
  const area = { type: "Polygon", coordinates: [ring(ENC_BOX)] };
  writeCell(dir, {
    DSID: { type: "FeatureCollection", features: [feature(null, { DSID_DSNM: "FR1ENC01.000" })] },
    M_COVR: { type: "FeatureCollection", features: [feature(area, { CATCOV: 1 })] },
    M_QUAL: { type: "FeatureCollection", features: [feature(area, { CATZOC: 1 })] },
    DEPARE: { type: "FeatureCollection", features: [feature(area, { DRVAL1: ENC_DEPTH })] }
  } as never);
  return readCellDirectory(dir, 0);
}

function odcCell(cellRef: number, depth = ODC_DEPTH): ReadCell {
  const tiles = path.join(TMP, "odc-tiles.bin");
  const pad = (E - W) / 20;
  const fd = fs.openSync(tiles, "w");
  writeStagedTile(fd, {
    ...TILE,
    data: encodeTile(TILE, {
      DEPARE: [
        {
          polygon: [[ring([W - pad, S - pad, E + pad, N + pad])]],
          properties: { DRVAL1: depth, DRVAL2: depth + 5 }
        }
      ]
    })
  });
  fs.closeSync(fd);
  const dir = path.join(TMP, "OD1ODC01");
  writeOdcCell({ tiles, dir, bbox: [W, S, E, N], now: new Date(NOW).toISOString(), catzoc: 4 });
  return readCellDirectory(dir, cellRef);
}

function wfsCell(cellRef: number, box: Bbox = [W, S, E, N], depth = WFS_DEPTH): ReadCell {
  const dir = path.join(TMP, "FI1WFS01");
  writeCell(
    dir,
    toCellLayers(
      {
        depthAreas: [
          feature(
            { type: "Polygon", coordinates: [ring(box)] },
            { DRVAL1: String(depth), DRVAL2: String(depth + 5), IDENTIFIER: "FI 1" }
          )
        ],
        dredgedAreas: [],
        soundings: []
      },
      box,
      new Date(NOW)
    )
  );
  return readCellDirectory(dir, cellRef);
}

function build(cells: (ref: number) => ReadCell[]): ChartIndex {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return buildChartIndex(cells(0), { minZoom: 12, leafZoom: 18 });
}

const at = (index: ChartIndex, x: number, y: number) =>
  minDepthOver(index.pyramid, footprintGeom([[lon(x), lat(y)]]));

function nav(x: number, y: number): NavState {
  return {
    position: { value: [lon(x), lat(y)], at: NOW },
    cog: { value: 0, at: NOW },
    sog: { value: 0, at: NOW },
    heading: { value: 0, at: NOW }
  };
}

function legOver(index: ChartIndex, y: number, from: number, to: number) {
  return checkRoute(
    index,
    {
      coordinates: [
        [lon(from), lat(y)],
        [lon(to), lat(y)]
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
  ).legs[0];
}

describe.each([
  ["Open Data Charts", () => build(() => [encCell(), odcCell(1)]), ODC_DEPTH],
  ["the Traficom WFS", () => build(() => [encCell(), wfsCell(1)]), WFS_DEPTH]
])("a band-1 ENC cell over %s", (_name, make, advisoryDepth) => {
  const index = make();

  test("the ENC depth is read where the ENC covers, unflagged", () => {
    const enc = at(index, 0.25, 0.5);
    expect(enc.dMin).toBe(ENC_DEPTH);
    expect(enc.cellRef).toBe(0);
    expect(enc.flags & (FLAGS.NOT_FOR_NAVIGATION | FLAGS.UNASSESSED)).toBe(0);
    const advisory = at(index, 0.75, 0.5);
    expect(advisory.dMin).toBe(advisoryDepth);
    expect(advisory.flags & FLAGS.NOT_FOR_NAVIGATION).toBeTruthy();
  });

  test("the look-ahead there can be normal, and a leg there ok", () => {
    expect(evaluateLookahead(nav(0.25, 0.5), ctx(KEEL), index, NOW).state).toBe("normal");
    const leg = legOver(index, 0.5, 0.15, 0.3);
    expect(leg?.flags).toEqual([]);
    expect(leg?.status).toBe("ok");
  });
});

describe("Open Data Charts beside the Traficom WFS, no ENC", () => {
  const index = build(() => [odcCell(0), wfsCell(1)]);

  test("the shallowest of the two is read, still advisory", () => {
    const water = at(index, 0.5, 0.5);
    expect(water.dMin).toBe(Math.min(ODC_DEPTH, WFS_DEPTH));
    expect(water.flags & FLAGS.NOT_FOR_NAVIGATION).toBeTruthy();
    expect(evaluateLookahead(nav(0.5, 0.5), ctx(KEEL), index, NOW).state).not.toBe("normal");
  });
});

describe("the look-ahead's notice over advisory water", () => {
  // Open Data Charts over the tile alone; the WFS from its middle to the end of the next tile.
  const index = build(() => [odcCell(0, 20), wfsCell(1, [lon(0.5), S, lon(2), N], 20)]);
  const reason = (x: number) => evaluateLookahead(nav(x, 0.5), ctx(KEEL), index, NOW).reason;

  test("names only the sources whose water the footprint reads", () => {
    expect(reason(0.2)).toBe(ODC_NOTICE);
    expect(reason(1.5)).toBe(WFS_NOTICE);
    const both = reason(0.75);
    expect(both).toContain(ODC_NOTICE);
    expect(both).toContain(WFS_NOTICE);
  });
});
