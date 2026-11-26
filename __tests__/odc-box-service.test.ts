import fs from "fs";
import os from "os";
import path from "path";
import type { OdcTiles } from "../src/charts-provider-tiles";
import type { LonLat } from "../src/foundation/geo";
import type { Bbox } from "../src/ingest/wfs";
import { ODC_CELL_NAME, tileBbox, writeStagedTile } from "../src/ingest/odc";
import type { ChartIndex } from "../src/spatial/chart-index";
import type { IndexBuilder, WfsServiceDeps } from "../src/wfs-service";
import { inThreadRefresher, WfsService } from "../src/wfs-service";
import { encodeTile } from "./helpers/mvt-encode";

/**
 * The chart box around the vessel with Open Data Charts on (`odc-box.ts`): the tiles of each
 * box are staged on the main thread, written as a cell by the build and built with the ENC.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-odc-box-"));
const CHARTS = path.join(TMP, "charts");
const ENC = path.join(CHARTS, "FR5ENC01.000");
const ODC_DIR = path.join(TMP, ODC_CELL_NAME);
const TILE = { z: 15, x: 15920, y: 11414 };
const [W, S, E, N] = tileBbox(TILE);
const POS: LonLat = [(W + E) / 2, (S + N) / 2];

/** Charts Provider's Open Data Charts as the box service sees them, one tile per box. */
function fakeOdc() {
  const odc = { key: "odc-a 9/248/178" as string | undefined, staged: [] as Bbox[] };
  const tiles: OdcTiles = {
    key: () => odc.key,
    stage: (bbox, file) => {
      odc.staged.push(bbox);
      const fd = fs.openSync(file, "w");
      writeStagedTile(fd, {
        ...TILE,
        data: encodeTile(TILE, {
          SOUNDG: [{ point: [[POS[0], POS[1]]], properties: { DEPTH: 8 } }]
        })
      });
      fs.closeSync(fd);
      return Promise.resolve(1);
    }
  };
  return { odc, tiles };
}

function harness(tiles: OdcTiles) {
  const t = { now: 1_800_000_000_000, index: undefined as ChartIndex | undefined };
  const built: string[][] = [];
  const build: IndexBuilder = (job) => {
    built.push(job.dirs);
    return Promise.resolve({ catalogue: { version: 1, cells: [] } } as unknown as ChartIndex);
  };
  const deps: WfsServiceDeps = {
    config: { radiusKm: 5 },
    dir: TMP,
    indexDir: path.join(TMP, "index"),
    leafZoom: 20,
    cellsDir: CHARTS,
    inBox: true,
    index: () => t.index,
    refresh: inThreadRefresher(() => Promise.reject(new Error("no WFS here")), build),
    clock: { now: () => t.now, setInterval: () => 1, clearInterval: () => undefined },
    position: () => POS,
    motion: () => undefined,
    lookahead: { distance: 555.6, minHorizon: 60 },
    onIndex: (i) => {
      t.index = i;
    },
    odc: { tiles, catzoc: 4 },
    error: (m) => {
      throw new Error(m);
    }
  };
  return { t, built, service: new WfsService(deps) };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(CHARTS, { recursive: true });
  fs.writeFileSync(ENC, "S-57 base cell");
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("Open Data Charts in the box around the vessel", () => {
  test("a box's tiles are built as a cell after the ENC, and the staged tiles removed", async () => {
    const { odc, tiles } = fakeOdc();
    const h = harness(tiles);
    await h.service.check();
    expect(odc.staged).toHaveLength(1);
    expect(h.built).toEqual([[ENC, ODC_DIR]]);
    expect(fs.existsSync(path.join(ODC_DIR, "SOUNDG.geojson"))).toBe(true);
    expect(fs.existsSync(path.join(TMP, "odc-tiles.bin"))).toBe(false);
    expect(h.service.status().box).toMatchObject({ odc: odc.key, odcTiles: 1 });
  });

  test("the box is built again once the charts meeting it change, not before", async () => {
    const { odc, tiles } = fakeOdc();
    const h = harness(tiles);
    await h.service.check();
    h.t.now += 120_000;
    await h.service.check();
    expect(h.built).toHaveLength(1);
    odc.key = "odc-a 9/248/178\nodc-b 9/249/178";
    h.t.now += 120_000;
    await h.service.check();
    expect(h.built).toHaveLength(2);
  });

  test("with no chart over the box only the ENC is built", async () => {
    const { odc, tiles } = fakeOdc();
    odc.key = undefined;
    const h = harness(tiles);
    await h.service.check();
    expect(odc.staged).toHaveLength(0);
    expect(h.built).toEqual([[ENC]]);
    expect(h.service.status().box?.odcTiles).toBeUndefined();
  });

  test("a start uses the saved cell, and builds the box again when the cell is torn", async () => {
    const { tiles } = fakeOdc();
    const first = harness(tiles);
    await first.service.check();
    expect(harness(tiles).service.savedCells()).toEqual([ODC_DIR]);
    fs.writeFileSync(path.join(ODC_DIR, "DSID.geojson"), "");
    const again = harness(tiles);
    expect(again.service.savedCells()).toEqual([]);
    again.t.index = first.t.index;
    await again.service.check();
    expect(again.built).toEqual([[ENC, ODC_DIR]]);
  });
});
