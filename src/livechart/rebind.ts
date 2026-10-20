import type { Rect } from "../foundation/geo";
import { groundToMercator, maxAbsLat, rectGap, tileRect } from "../foundation/geo";
import { MAX_CHART_BUFFER } from "../spatial/chart-position";
import type { CellPosterior } from "./posterior";

/**
 * The living-chart cells whose chart prior can differ between two indexes built from the same
 * cells except inside `changed` (Mercator rects). chartPrior() reads only the tiles inside the
 * cell, so a cell clear of every rect reads the same tiles in both; the margin, one cell plus
 * MAX_CHART_BUFFER, also covers a prior that counts tiles within their chart position reach.
 */
export function cellsNear(changed: readonly Rect[]): (c: CellPosterior) => boolean {
  return (c) => {
    const t = tileRect(c.z, c.x, c.y);
    const reach = groundToMercator(MAX_CHART_BUFFER, maxAbsLat(t)) + (t.maxX - t.minX);
    return changed.some((r) => rectGap(t, r) <= reach);
  };
}
