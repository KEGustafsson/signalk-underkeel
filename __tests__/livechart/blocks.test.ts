import fs from "fs";
import os from "os";
import path from "path";
import type { LonLat } from "../../src/foundation/geo";
import { tileAt, toMercator } from "../../src/foundation/geo";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import { chartPrior } from "../../src/livechart/posterior";
import { cacheOf } from "../../src/spatial/block-cache";
import type { NodeStore } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { pyramidFromBuffer, serializePyramid } from "../../src/spatial/store";
import { basin, point } from "../helpers/synthetic";

/**
 * The living chart on an index read block by block (plan §4.13): a chart prior is read only
 * from a loaded block, never from the stand-ins a query reads while it loads, so a cell is
 * judged against its own charted depth after a start, a rebind or a first sounding.
 */

const T0 = 1_800_000_000_000;
const CONFIG: LivechartConfig = {
  source: { path: "environment.depth.belowSurface", transducerDepth: 0, forward: 0, starboard: 0 },
  writeNotes: false,
  csb: { id: "anon", idType: "Other" }
};
const SHOAL: LonLat = [22.0505, 60.0505];
/** A 2 m rock in the shoal cell's z15 tile but not in its z18 cell. */
const ROCK: LonLat = [22.0535, 60.0505];

const whole = buildPyramid([...basin([22.0, 60.0, 22.1, 60.1], 10), point(...ROCK, 2)], {
  minZoom: 12,
  leafZoom: 18
});
const file = serializePyramid(whole, { residentZoom: 15, blockZoom: 13 });

/** The index read block by block, nothing loaded, every block read off the event loop. */
const cold = (): NodeStore => pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: -1 });

const away = () => buildPyramid(basin([23.0, 61.0, 23.1, 61.1], 10), { minZoom: 12, leafZoom: 18 });

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function service(store: NodeStore, file = path.join(tmp(), "livechart.json")) {
  return new LivechartService(store, CONFIG, file, {
    setNote: () => Promise.resolve(),
    error: (m) => {
      throw new Error(m);
    },
    now: () => T0
  });
}

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-lc-blocks-"));
  dirs.push(dir);
  return dir;
}

/** `n` soundings of `depth` at the shoal, in two passes 15 minutes apart. */
function sound(svc: LivechartService, depth: number, n: number): void {
  for (let k = 0; k < n; k++) {
    const at = T0 + (k < n / 2 ? 0 : 15 * 60_000) + k * 1000;
    svc.onSounding({
      depth,
      at,
      position: SHOAL,
      positionAt: at,
      hdop: 0.9,
      methodQuality: "GNSS Fix",
      waterLevel: { h: 0, sigma: 0.05, source: "manual" }
    });
  }
}

const shoalDepth = (store: NodeStore) => minDepthOver(store, footprintGeom([SHOAL])).dMin;

describe("living chart on an index read block by block", () => {
  test("the fixture's stand-in prior for the shoal cell is the rock's depth", () => {
    const [mx, my] = toMercator(...SHOAL);
    const [rx, ry] = toMercator(...ROCK);
    expect(tileAt(15, rx, ry)).toEqual(tileAt(15, mx, my));
    expect(tileAt(18, rx, ry)).not.toEqual(tileAt(18, mx, my));
    const { x, y } = tileAt(18, mx, my);
    expect(chartPrior(whole, 18, x, y).depth).toBe(10);
    expect(chartPrior(cold(), 18, x, y).depth).toBe(2);
  });

  test("a cell first sounded before its block loads is judged against the loaded chart", async () => {
    const store = cold();
    const svc = service(store);
    sound(svc, 6, 6);
    expect(svc.status()).toMatchObject({ unsettled: 1, discrepancies: 0 });
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 0, discrepancies: 1 });
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10 });
    expect(shoalDepth(store)).toBeLessThan(7);
  });

  test("a cell over a block refused for good stays unsettled, never judged on stand-ins", async () => {
    const store = cold();
    const cache = cacheOf(store);
    const [mx, my] = toMercator(...SHOAL);
    const { x, y } = tileAt(cache?.blockZoom ?? 13, mx, my);
    const key = x * 2 ** (cache?.blockZoom ?? 13) + y;
    cache?.failed.set(key, "pyramid file is corrupt");
    const svc = service(store);
    sound(svc, 6, 6);
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 1, discrepancies: 0 });
  });

  test("cells restored at start wait for their block, then are judged against it", async () => {
    // Four soundings: not yet a discrepancy, and saved so.
    const saved = path.join(tmp(), "livechart.json");
    const first = service(whole, saved);
    sound(first, 6, 4);
    first.save();

    const store = cold();
    const svc = service(store, saved);
    expect(cacheOf(store)?.count).toBe(0);
    expect(svc.status()).toMatchObject({ unsettled: 1 });
    // A fifth sounding before the block loads is not judged against a stand-in.
    sound(svc, 6, 1);
    await svc.whenSettled();
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10, samples: 5 });
    expect(shoalDepth(store)).toBeLessThan(7);
  });

  test("a rebind prepared onto an index read block by block waits for the blocks", async () => {
    // Uncharted at first: no prior to be shallower than.
    const svc = service(away());
    sound(svc, 6, 6);
    expect(svc.discrepancies()).toEqual([]);
    const store = cold();
    const apply = await svc.prepareRebind(
      store,
      () => true,
      () => new Promise((r) => setImmediate(r))
    );
    apply();
    expect(svc.status()).toMatchObject({ unsettled: 0 });
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10 });
    expect(shoalDepth(store)).toBeLessThan(7);
  });

  test("a rebind done at once leaves the cell unsettled until its block loads", async () => {
    const svc = service(away());
    sound(svc, 6, 6);
    const store = cold();
    svc.rebind(store);
    expect(svc.discrepancies()).toEqual([]);
    expect(svc.status()).toMatchObject({ unsettled: 1 });
    await svc.whenSettled();
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10 });
  });

  test("a stopped service settles nothing more", async () => {
    const store = cold();
    const svc = service(store);
    sound(svc, 6, 6);
    svc.stop();
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 1, discrepancies: 0 });
  });
});
