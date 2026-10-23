import { tileKey } from "../foundation/geo";
import type { NodeStore } from "../spatial/node-store";
import type { Posteriors } from "./posterior";
import { unloadedBlock } from "./chart-blocks";
import { chartPrior, noPrior, rebasePrior, withPeak } from "./posterior";
import { isCell, isNodeValues, listOf, mergeAdjustments, tilesAt } from "./saved-state";

/** Restoring a saved `cells.ndjson` and `livechart.json` onto the current index. */

/**
 * Restores the cells at the current living-chart zoom and returns how many were malformed.
 * Cells at another zoom are keyed at that zoom and dropped; their adjustments are mapped.
 * The index may have been rebuilt since the save, so every cell waits, unsettled with
 * noPrior(), for the settler to move it onto the current chart's prior and cell reference in
 * slices; a saved cellRef indexes the catalogue it was saved with. Start-up thus reads no chart
 * prior per cell, which for a long history blocked a Raspberry Pi for seconds, and starts no
 * load of a block. A cell's peakZ is first raised against the prior it was saved with, so a
 * cell saved before peakZ existed keeps the evidence it held then.
 */
export function restoreCells(cells: unknown[], store: NodeStore, posteriors: Posteriors): number {
  const z = store.adjustZoom;
  let malformed = 0;
  for (const c of cells) {
    if (!isCell(c)) {
      malformed++;
    } else if (c.z === z) {
      // An uncharted cell's NaN prior is saved as null.
      const chartDepth = typeof c.chartDepth === "number" ? c.chartDepth : NaN;
      const key = tileKey(c.z, c.x, c.y);
      posteriors.cells.set(key, rebasePrior(withPeak({ ...c, chartDepth }), noPrior(c.cellRef)));
      posteriors.unsettled.add(key);
    }
  }
  return malformed;
}

/**
 * Restores saved adjustments at the current zoom and returns how many were malformed. They
 * keep their depths, since they only ever lower a cell: onto a coarser zoom a cell takes the
 * shallowest depth and largest σ of the saved cells in it, onto a finer one every cell inside
 * a saved one takes its values.
 */
export function restoreAdjustments(
  adjustments: unknown,
  from: number,
  store: NodeStore,
  posteriors: Posteriors
): number {
  const z = store.adjustZoom;
  let malformed = 0;
  for (const entry of listOf(adjustments)) {
    const [key, v] = Array.isArray(entry) ? (entry as unknown[]) : [];
    const valid = Number.isSafeInteger(key) && (key as number) >= 0 && (key as number) < 4 ** from;
    if (!(valid && isNodeValues(v))) {
      malformed++;
      continue;
    }
    for (const t of tilesAt(key as number, from, z)) {
      const k = tileKey(z, t.x, t.y);
      const next = { ...v, cellRef: cellRefAt(store, posteriors, z, k) };
      store.adjustments.set(k, mergeAdjustments(store.adjustments.get(k), next));
    }
  }
  return malformed;
}

/**
 * The current chart's cell reference for living-chart cell `key`; one read from a block's
 * stand-ins leaves the key unsettled.
 */
export function cellRefAt(
  store: NodeStore,
  posteriors: Posteriors,
  z: number,
  key: number
): number {
  const c = posteriors.cells.get(key);
  if (c) {
    return c.cellRef;
  }
  const n = 2 ** z;
  const [x, y] = [Math.floor(key / n), key % n];
  const { cellRef } = chartPrior(store, z, x, y);
  if (unloadedBlock(store, z, x, y) !== undefined) {
    posteriors.unsettled.add(key);
  }
  return cellRef;
}
