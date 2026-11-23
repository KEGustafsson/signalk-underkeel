import type { ChartIndex } from "./spatial/chart-index";

const cellKey = (c: { name: string; edition: number; update: number }): string =>
  `${c.name}/${c.edition}/${c.update}`;

/** The revision of the living chart's adjustments each planning store last took, and from what. */
const carried = new WeakMap<object, { from: object; revision: number }>();

/**
 * Puts the living chart's adjustments of `from` (the index in use) on `to` (a planning box),
 * each with the catalogue reference of the same cell in `to`. Taking them only lowers a depth
 * (invariant 5), so a planning box reads no deeper than the index in use where the boat has
 * sounded. False when the two index the adjustments at different zooms and cannot share them.
 */
export function carryAdjustments(from: ChartIndex, to: ChartIndex): boolean {
  const src = from.pyramid.adjustments;
  const dst = to.pyramid.adjustments;
  const last = carried.get(to.pyramid);
  if (last && last.from === from.pyramid && last.revision === src.revision) {
    return true;
  }
  if (src.size > 0 && from.pyramid.adjustZoom !== to.pyramid.adjustZoom) {
    return false;
  }
  const refs = new Map(to.catalogue.cells.map((c, i) => [cellKey(c), i]));
  const cells = from.catalogue.cells;
  dst.clear();
  for (const [key, v] of src) {
    const cell = cells[v.cellRef];
    dst.set(key, { ...v, cellRef: cell ? (refs.get(cellKey(cell)) ?? -1) : -1 });
  }
  carried.set(to.pyramid, { from: from.pyramid, revision: src.revision });
  return true;
}
