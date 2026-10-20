import { tileKey } from "../foundation/geo";
import type { NodeStore } from "../spatial/node-store";
import type { Posteriors } from "./posterior";
import { chartPrior, rebasePrior } from "./posterior";
import { isCell, isNodeValues, listOf, mergeAdjustments, tilesAt } from "./saved-state";

/** Restoring a saved `livechart.json` onto the current index. */

/**
 * Restores the cells at the current living-chart zoom and returns how many were malformed.
 * Cells at another zoom are keyed at that zoom and dropped; their adjustments are mapped.
 * The index may have been rebuilt since the save, so each cell is moved onto the current
 * chart's prior and cell reference; a saved cellRef indexes the catalogue it was saved with.
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
      const current = chartPrior(store, c.z, c.x, c.y);
      posteriors.cells.set(tileKey(c.z, c.x, c.y), rebasePrior({ ...c, chartDepth }, current));
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

/** The current chart's cell reference for living-chart cell `key`. */
export function cellRefAt(
  store: NodeStore,
  posteriors: Posteriors,
  z: number,
  key: number
): number {
  const n = 2 ** z;
  return (
    posteriors.cells.get(key)?.cellRef ?? chartPrior(store, z, Math.floor(key / n), key % n).cellRef
  );
}
