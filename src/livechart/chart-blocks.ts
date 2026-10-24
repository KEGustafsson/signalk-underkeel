import { tileKey } from "../foundation/geo";
import { cacheOf } from "../spatial/block-cache";
import type { NodeStore } from "../spatial/node-store";

/**
 * The chart blocks living-chart priors read (plan §4.13). A store read block by block answers
 * a query over a block not loaded from its stand-ins, which can put a cell's prior metres
 * shallower or leave it uncharted, so a prior is read only once its block is loaded.
 */

interface Cell {
  z: number;
  x: number;
  y: number;
}

/**
 * The block of a store read block by block whose stand-ins the chart prior of cell (z, x, y)
 * would read now: the one holding the cell, while it is not loaded. undefined when the prior
 * reads the chart itself. A block refused for good stays so, and its cells stay unsettled
 * rather than be judged against chart data that was never read.
 */
export function unloadedBlock(
  store: NodeStore,
  z: number,
  x: number,
  y: number
): number | undefined {
  const cache = cacheOf(store);
  if (!cache || z < cache.blockZoom) {
    return undefined;
  }
  const d = z - cache.blockZoom;
  const key = tileKey(cache.blockZoom, x >>> d, y >>> d);
  return cache.unloaded(key) ? key : undefined;
}

/**
 * Runs `fn` on each of `cells` while the block its prior reads is loaded, a block at a time,
 * each read off the event loop first; a cell whose block cannot be read now is left out.
 * `pause` runs after every `slice` cells, and the run ends after a wait once `live()` is false.
 */
export async function withBlocksLoaded<T extends Cell>(
  store: NodeStore,
  cells: readonly T[],
  fn: (c: T) => void,
  opts: { slice: number; pause: () => Promise<void>; live?: () => boolean }
): Promise<void> {
  const live = opts.live ?? (() => true);
  const byBlock = cells
    .map((c) => ({ c, block: unloadedBlock(store, c.z, c.x, c.y) ?? -1 }))
    .sort((a, b) => a.block - b.block);
  let n = 0;
  for (const { c } of byBlock) {
    const block = unloadedBlock(store, c.z, c.x, c.y);
    if (block !== undefined) {
      await cacheOf(store)?.load(block);
      if (!live()) {
        return;
      }
    }
    if (unloadedBlock(store, c.z, c.x, c.y) === undefined) {
      fn(c);
      if (++n % opts.slice === 0) {
        await opts.pause();
        if (!live()) {
          return;
        }
      }
    }
  }
}
