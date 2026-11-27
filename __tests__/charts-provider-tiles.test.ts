import fs from "fs";
import os from "os";
import path from "path";
import type { ChartTilesApi, TilesChart } from "../src/charts-provider-tiles";
import {
  chartsProviderOdc,
  odcCharts,
  odcTilesOf,
  TILES_PROPERTY,
  watchChartTiles
} from "../src/charts-provider-tiles";
import type { Bbox } from "../src/ingest/wfs";
import { readStagedTiles, tileBbox } from "../src/ingest/odc";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-cp-tiles-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const A = { z: 15, x: 15920, y: 11414 };
const [W, S, E, N] = tileBbox(A);
/** Inside tile A, so one z15 tile meets it. */
const BOX: Bbox = [W + 1e-5, S + 1e-5, E - 1e-5, N - 1e-5];

const chart = (over: Partial<TilesChart> = {}): TilesChart => ({
  id: "odc-france-atlantic",
  format: "pbf",
  maxzoom: 17,
  bounds: [-5.7, 47.5, -4.9, 48],
  openDataSet: "france-atlantic",
  coverage: [{ tiles: [`9/${A.x >> 6}/${A.y >> 6}`] }],
  ...over
});

function offer(charts: TilesChart[], read: string[] = []): ChartTilesApi {
  return {
    charts: () => charts,
    getTile: (id, z, x, y) => {
      read.push(`${id} ${z}/${x}/${y}`);
      return Promise.resolve(Uint8Array.from([1, 2, 3]));
    }
  };
}

describe("Open Data Charts through Charts Provider's chartTiles", () => {
  test("only Open Data Charts vector charts reaching z15 with coverage over the box are read", () => {
    const charts = [
      chart({ id: "b" }),
      chart({ id: "a" }),
      chart({ id: "enc", openDataSet: undefined }),
      chart({ id: "raster", format: "png" }),
      chart({ id: "overview", maxzoom: 12 }),
      chart({ id: "far", bounds: [10, 50, 11, 51] }),
      chart({ id: "no-coverage", coverage: undefined })
    ];
    const broken: ChartTilesApi = {
      charts: () => {
        throw new Error("not ready");
      },
      getTile: () => Promise.resolve(null)
    };
    expect(odcCharts([offer(charts), broken], BOX).map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("the key names the charts and their tiles, and none while no chart meets the box", () => {
    const charts: TilesChart[] = [chart()];
    const tiles = odcTilesOf(() => [offer(charts)]);
    expect(tiles.key(BOX)).toBe(`odc-france-atlantic 9/${A.x >> 6}/${A.y >> 6}`);
    charts.pop();
    expect(tiles.key(BOX)).toBeUndefined();
  });

  test("staging reads the box's covered z15 tiles and writes those with a body", async () => {
    const read: string[] = [];
    const tiles = odcTilesOf(() => [offer([chart()], read)]);
    const file = path.join(TMP, "staged.bin");
    expect(await tiles.stage(BOX, file, new AbortController().signal)).toBe(1);
    expect(read).toEqual([`odc-france-atlantic 15/${A.x}/${A.y}`]);
    expect(readStagedTiles(file).map((t) => [t.z, t.x, t.y, t.data.length])).toEqual([
      [15, A.x, A.y, 3]
    ]);
    const empty = odcTilesOf(() => [
      { charts: () => [chart()], getTile: () => Promise.resolve(undefined) }
    ]);
    expect(await empty.stage(BOX, file, new AbortController().signal)).toBe(0);
  });

  test("a chart list that cannot be read when staging fails the staging, not reads none", async () => {
    let calls = 0;
    const flaky: ChartTilesApi = {
      charts: () => {
        if (++calls > 1) {
          throw new Error("charts reloading");
        }
        return [chart()];
      },
      getTile: () => Promise.resolve(Uint8Array.from([1]))
    };
    const tiles = odcTilesOf(() => [flaky]);
    expect(tiles.key(BOX)).toBeDefined();
    await expect(
      tiles.stage(BOX, path.join(TMP, "flaky.bin"), new AbortController().signal)
    ).rejects.toThrow("charts reloading");
  });

  test("an aborted staging rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    const tiles = odcTilesOf(() => [offer([chart()])]);
    await expect(tiles.stage(BOX, path.join(TMP, "x.bin"), controller.signal)).rejects.toThrow(
      "aborted"
    );
  });

  test("an abort while a read is pending writes no tile and rejects", async () => {
    const controller = new AbortController();
    const tiles = odcTilesOf(() => [
      {
        charts: () => [chart()],
        getTile: () => {
          controller.abort();
          return Promise.resolve(Uint8Array.from([1]));
        }
      }
    ]);
    const file = path.join(TMP, "pending.bin");
    await expect(tiles.stage(BOX, file, controller.signal)).rejects.toThrow("aborted");
    expect(readStagedTiles(file)).toEqual([]);
  });

  test("the latest offer of each setter is followed, and forgotten when watching stops", () => {
    let deliver: (h: ({ setter?: string; value: unknown } | undefined)[]) => void = () => {};
    let names: string[] = [];
    const stop = watchChartTiles({
      onPropertyValues: (name, cb) => {
        names.push(name);
        deliver = cb;
        return () => {
          names = [];
        };
      }
    });
    expect(names).toEqual([TILES_PROPERTY]);
    deliver([
      { setter: "charts-provider", value: offer([chart({ id: "old" })]) },
      { setter: "other", value: { not: "an offer" } },
      undefined,
      { setter: "charts-provider", value: offer([chart({ id: "new" })]) }
    ]);
    expect(chartsProviderOdc.key(BOX)).toMatch(/^new /);
    stop();
    expect(names).toEqual([]);
    expect(chartsProviderOdc.key(BOX)).toBeUndefined();
    expect(watchChartTiles({})()).toBeUndefined();
  });
});
