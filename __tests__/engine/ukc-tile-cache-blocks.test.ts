import { rectGap, tileAt, tileRect, toMercator } from "../../src/foundation/geo";
import { tileGeometry, UkcTileCache } from "../../src/engine/ukc-tile-geometry";
import { cacheOf } from "../../src/spatial/block-cache";
import { MAX_CHART_BUFFER } from "../../src/spatial/chart-position";
import { mercatorBuffer } from "../../src/spatial/pyramid";
import type { BlockLayout } from "../../src/spatial/pyramid-blocks";
import { pyramidFromBuffer, serializePyramid } from "../../src/spatial/store";
import { FAIRWAY_LAT, fixtureIndex } from "../helpers/fixture-index";

/**
 * The tile cache with the pyramid read block by block: a tile cached while
 * its block read as stand-ins is walked again once the block loads, and again
 * once it is dropped, so a cached tile always equals a fresh walk.
 */

const FINE: BlockLayout = { residentZoom: 15, blockZoom: 13 };
const file = serializePyramid(fixtureIndex().pyramid, FINE);

function cold() {
  const pyramid = pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: -1 });
  const cache = cacheOf(pyramid);
  if (!cache) {
    throw new Error("expected a block-read store");
  }
  return { pyramid, cache };
}

test.each([12, 13, 14])(
  "a z%i tile cached over an unloaded block follows the block in and out",
  (z) => {
    const { pyramid, cache } = cold();
    const [mx, my] = toMercator(22.004, FAIRWAY_LAT);
    const { x, y } = tileAt(z, mx, my);
    const tiles = new UkcTileCache();
    const standIn = tiles.geometry(pyramid, z, x, y);
    expect(standIn).toEqual(tileGeometry(pyramid, z, x, y));

    cache.keys().forEach((key) => cache.loadNow(key));
    const loaded = tiles.geometry(pyramid, z, x, y);
    expect(loaded).toEqual(tileGeometry(pyramid, z, x, y));
    expect(loaded).not.toEqual(standIn);
  }
);

/** A block's tile rectangle, and how far the tile at the fairway is from it beyond the chart reach. */
function beyondReach(key: number, x: number, y: number): number {
  const n = 2 ** FINE.blockZoom;
  const block = tileRect(FINE.blockZoom, Math.floor(key / n), key % n);
  const tile = tileRect(14, x, y);
  return rectGap(tile, block) - mercatorBuffer(tile, MAX_CHART_BUFFER);
}

test("a tile beyond the chart reach of a block that loads keeps its cached geometry", () => {
  const { pyramid, cache } = cold();
  const [mx, my] = toMercator(22.004, FAIRWAY_LAT);
  const { x, y } = tileAt(14, mx, my);
  const far = cache.keys().find((key) => beyondReach(key, x, y) > 0);
  expect(far).toBeDefined();
  cache.keys().forEach((key) => key !== far && cache.loadNow(key));
  const tiles = new UkcTileCache();
  const first = tiles.geometry(pyramid, 14, x, y);
  cache.loadNow(far as number);
  expect(tiles.geometry(pyramid, 14, x, y)).toBe(first);
});

test("a tile beside a block that loads, within its chart reach, is walked again", () => {
  const { pyramid, cache } = cold();
  const n = 2 ** FINE.blockZoom;
  const [mx, my] = toMercator(22.004, FAIRWAY_LAT);
  const { x, y } = tileAt(14, mx, my);
  const own = (x >> 1) * n + (y >> 1);
  const near = cache.keys().find((key) => key !== own && beyondReach(key, x, y) <= 0);
  expect(near).toBeDefined();
  cache.keys().forEach((key) => key !== near && cache.loadNow(key));
  const tiles = new UkcTileCache();
  const first = tiles.geometry(pyramid, 14, x, y);
  cache.loadNow(near as number);
  const again = tiles.geometry(pyramid, 14, x, y);
  expect(again).not.toBe(first);
  expect(again).toEqual(tileGeometry(pyramid, 14, x, y));
});
