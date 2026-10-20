import { DEFAULT_LOOKAHEAD } from "../src/engine/lookahead";
import { MAX_POSITION_BUFFER } from "../src/engine/fan";
import type { LonLat } from "../src/foundation/geo";
import { project, rectContainsRect, toMercator } from "../src/foundation/geo";
import { keepBlocksNearVessel, keptRects, PREFETCH_SECONDS } from "../src/block-keeper";
import type { Monitor } from "../src/monitor";
import { cacheOf } from "../src/spatial/block-cache";
import { MAX_CHART_BUFFER } from "../src/spatial/chart-position";
import { mercatorBuffer } from "../src/spatial/pyramid";
import { pyramidFromBuffer, serializePyramid } from "../src/spatial/store";
import { FAIRWAY_LAT, fixtureIndex } from "./helpers/fixture-index";

/** The blocks the look-ahead can reach, and those ahead on the course, are kept loaded (IX-11). */

const P: LonLat = [22.01, FAIRWAY_LAT];

function square(p: LonLat, metres: number) {
  const [x, y] = toMercator(p[0], p[1]);
  const r = mercatorBuffer({ minX: x, minY: y, maxX: x, maxY: y }, metres);
  return { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
}

test("the kept squares hold the look-ahead's reach here and PREFETCH_SECONDS ahead", () => {
  const opts = { ...DEFAULT_LOOKAHEAD, distance: 1000, minHorizon: 60 };
  const reach = 6 * 60 + MAX_POSITION_BUFFER + MAX_CHART_BUFFER;
  const [here, ahead] = keptRects(P, Math.PI / 2, 6, opts);
  expect(rectContainsRect(here!, square(P, reach - 1))).toBe(true);
  const next = project(P, Math.PI / 2, 6 * PREFETCH_SECONDS);
  expect(rectContainsRect(ahead!, square(next, reach - 1))).toBe(true);
  // At rest only the square around the vessel, of the look-ahead distance.
  const still = keptRects(P, Math.PI / 2, 0, opts);
  expect(still).toHaveLength(1);
  expect(
    rectContainsRect(still[0]!, square(P, 1000 + MAX_POSITION_BUFFER + MAX_CHART_BUFFER - 1))
  ).toBe(true);
});

test("a position update keeps the blocks around the vessel loaded, at most every 2 s", async () => {
  const pyramid = pyramidFromBuffer(
    serializePyramid(fixtureIndex().pyramid, { residentZoom: 15, blockZoom: 13 }),
    { budgetBytes: 1, syncBytes: Infinity }
  );
  const cache = cacheOf(pyramid);
  if (!cache) {
    throw new Error("no cache");
  }
  const keep = jest.spyOn(cache, "keep");
  let watcher: (() => void) | undefined;
  let now = 0;
  const monitor = {
    nav: { position: { value: P, at: 0 } },
    watch: (_: string[], fn: () => void) => (watcher = fn)
  } as unknown as Monitor;
  const clock = { now: () => now } as never;
  keepBlocksNearVessel(monitor, () => ({ ...fixtureIndex(), pyramid }), clock, DEFAULT_LOOKAHEAD);
  watcher?.();
  await keep.mock.results[0]?.value;
  const kept = cache.count;
  expect(kept).toBeGreaterThan(0);
  // Over the budget the kept blocks stay.
  cache.trim();
  expect(cache.count).toBe(kept);
  now = 1999;
  watcher?.();
  expect(keep).toHaveBeenCalledTimes(1);
  now = 2000;
  watcher?.();
  expect(keep).toHaveBeenCalledTimes(2);
});
