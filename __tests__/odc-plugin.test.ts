import fs from "fs";
import os from "os";
import path from "path";
import type { ChartTilesApi } from "../src/charts-provider-tiles";
import { TILES_PROPERTY } from "../src/charts-provider-tiles";
import { ODC_CELL_NAME, ODC_NOTICE, tileBbox } from "../src/ingest/odc";
import type { FetchLike } from "../src/model/fmi";
import type { IndexBuilder } from "../src/wfs-service";
import underkeel = require("../src/index");
import { inlineBuilder, prepareFixtureIndex } from "./helpers/fixture-index";
import { encodeTile } from "./helpers/mvt-encode";
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "./helpers/plugin-harness";

/**
 * Open Data Charts with no ENC source and the Traficom WFS off, as in waters with no free
 * official ENC: the box around the vessel is built from the charts alone.
 */

const TILE = { z: 15, x: 15920, y: 11414 };
const [W, S, E, N] = tileBbox(TILE);
const POS: [number, number] = [(W + E) / 2, (S + N) / 2];

/** Charts Provider's `chartTiles` with one Open Data Charts set: 20 m over one z15 tile. */
const offer: ChartTilesApi = {
  charts: () => [
    {
      id: "odc-france-atlantic",
      format: "pbf",
      maxzoom: 17,
      openDataSet: "france-atlantic",
      coverage: [{ tiles: [`9/${TILE.x >> 6}/${TILE.y >> 6}`] }]
    }
  ],
  getTile: (_id, z, x, y) =>
    Promise.resolve(
      z === TILE.z && x === TILE.x && y === TILE.y
        ? encodeTile(TILE, {
            DEPARE: [
              {
                polygon: [
                  [
                    [
                      [W, S],
                      [E, S],
                      [E, N],
                      [W, N],
                      [W, S]
                    ]
                  ]
                ],
                properties: { DRVAL1: 20, DRVAL2: 30 }
              }
            ]
          })
        : null
    )
};

const noFetch: FetchLike = () => Promise.reject(new Error("no network here"));
const build: IndexBuilder = inlineBuilder;
const settle = () => new Promise((r) => setImmediate(r));

beforeAll(prepareFixtureIndex);

describe("plugin with Open Data Charts alone", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-odc-plugin-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("with no ENC source and the WFS off, a box of the charts is built and read", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    Object.assign(h.app, {
      onPropertyValues: (
        name: string,
        cb: (history: { setter: string; value: unknown }[]) => void
      ) => {
        if (name === TILES_PROPERTY) {
          cb([{ setter: "signalk-charts-provider-simple", value: offer }]);
        }
        return () => undefined;
      }
    });
    const plugin = underkeel(h.app, clock, noFetch, build);
    plugin.start({ vessel: { draft: 2, length: 12, beam: 4 } }, () => undefined);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    h.send(navDelta(POS[0], POS[1], 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 20; i++) {
      await settle();
    }
    h.send(navDelta(POS[0], POS[1], 0, clock.now()));
    clock.advance(1000);
    const status = call("/v1/status").body as {
      engine: { reason: string };
      index: { cells: { name: string }[] };
    };
    expect(status.index.cells.map((c) => c.name)).toEqual([ODC_CELL_NAME]);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).toBe("alert");
    expect(status.engine.reason).toBe(ODC_NOTICE);
    plugin.stop();
  });
});
