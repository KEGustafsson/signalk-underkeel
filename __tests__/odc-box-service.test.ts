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
  const odc = {
    key: "odc-a 9/248/178" as string | null | undefined,
    staged: [] as Bbox[],
    fail: false
  };
  const tiles: OdcTiles = {
    key: () => odc.key,
    stage: (bbox, file) => {
      odc.staged.push(bbox);
      if (odc.fail) {
        fs.writeFileSync(file, "torn");
        return Promise.reject(new Error("tile store busy"));
      }
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

function harness(tiles: OdcTiles, catzoc = 4) {
  const t = { now: 1_800_000_000_000, index: undefined as ChartIndex | undefined };
  const built: string[][] = [];
  const errors: string[] = [];
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
    odc: { tiles, catzoc },
    error: (m) => errors.push(m)
  };
  return { t, built, errors, service: new WfsService(deps) };
}

/** As a real build leaves it: the index directory records the box it was built in. */
function indexedIn(h: ReturnType<typeof harness>): void {
  const indexDir = path.join(TMP, "index");
  fs.mkdirSync(indexDir, { recursive: true });
  const bbox = h.service.status().box?.bbox;
  fs.writeFileSync(
    path.join(indexDir, "box.json"),
    JSON.stringify({ version: 1, bbox, sources: [] })
  );
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
    expect(fs.readdirSync(TMP).filter((n) => n.startsWith("odc-tiles"))).toEqual([]);
    expect(h.service.status().box).toMatchObject({ odc: odc.key, odcTiles: 1, odcCatzoc: 4 });
    expect(h.errors).toEqual([]);
  });

  test("a failed tile read still builds the ENC, and the charts are read again 5 min later", async () => {
    const { odc, tiles } = fakeOdc();
    odc.fail = true;
    const h = harness(tiles);
    await h.service.check();
    expect(h.built).toEqual([[ENC]]);
    expect(h.errors).toEqual(["Open Data Charts not read: tile store busy"]);
    expect(h.service.status().box?.odc).toBeUndefined();
    // Told in the box's status line, which the plugin status and the look-ahead's box view show.
    expect(h.service.status().summary).toBe(
      "Open Data Charts not read: tile store busy (read again in 5 min)"
    );
    expect(h.service.view().summary).toBe(h.service.status().summary);
    expect(fs.readdirSync(TMP).filter((n) => n.startsWith("odc-tiles"))).toEqual([]);
    odc.fail = false;
    h.t.now += 120_000;
    await h.service.check();
    expect(h.built).toHaveLength(1);
    h.t.now += 240_000;
    await h.service.check();
    expect(h.built).toEqual([[ENC], [ENC, ODC_DIR]]);
    expect(h.service.status().summary).toBeUndefined();
  });

  test("a start before Charts Provider offers its tiles keeps the saved box", async () => {
    const { odc, tiles } = fakeOdc();
    const first = harness(tiles);
    await first.service.check();
    indexedIn(first);
    odc.key = undefined;
    const restarted = harness(tiles);
    restarted.t.index = first.t.index;
    await restarted.service.check();
    odc.key = "odc-a 9/248/178";
    restarted.t.now += 120_000;
    await restarted.service.check();
    expect(restarted.built).toEqual([]);
  });

  test("an Open Data Charts cell the build cannot write leaves the box with the ENC alone", async () => {
    const { odc } = fakeOdc();
    const torn: OdcTiles = {
      key: () => odc.key,
      stage: (_bbox, file) => {
        fs.writeFileSync(file, "torn");
        return Promise.resolve(1);
      }
    };
    const h = harness(torn);
    await h.service.check();
    expect(h.built).toEqual([[ENC]]);
    expect(h.service.status().box?.odcTiles).toBeUndefined();
    expect(h.service.status().summary).toMatch(/^Open Data Charts not read: /);
  });

  test("a new assumed survey quality builds the box again, after a restart too", async () => {
    const { tiles } = fakeOdc();
    const first = harness(tiles);
    await first.service.check();
    indexedIn(first);
    const same = harness(tiles);
    same.t.index = first.t.index;
    await same.service.check();
    expect(same.built).toEqual([]);
    const again = harness(tiles, 6);
    again.t.index = first.t.index;
    await again.service.check();
    expect(again.built).toEqual([[ENC, ODC_DIR]]);
    expect(again.service.status().box?.odcCatzoc).toBe(6);
  });

  test("a box no chart covers is not rebuilt over the survey quality", async () => {
    const { odc, tiles } = fakeOdc();
    odc.key = null;
    const first = harness(tiles);
    await first.service.check();
    indexedIn(first);
    const again = harness(tiles, 6);
    again.t.index = first.t.index;
    await again.service.check();
    expect(again.built).toEqual([]);
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
    odc.key = null;
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
    indexedIn(first);
    const kept = harness(tiles);
    kept.t.index = first.t.index;
    await kept.service.check();
    expect(kept.built).toEqual([]);
    fs.writeFileSync(path.join(ODC_DIR, "DSID.geojson"), "");
    const again = harness(tiles);
    expect(again.service.savedCells()).toEqual([]);
    again.t.index = first.t.index;
    await again.service.check();
    expect(again.built).toEqual([[ENC, ODC_DIR]]);
  });
});
