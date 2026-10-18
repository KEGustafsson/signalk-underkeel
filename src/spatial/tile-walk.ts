import type { NodeStore, NodeValues } from "./node-store";
import { NO_DATA } from "./node-store";

export interface TileCell {
  z: number;
  x: number;
  y: number;
  values: NodeValues;
  /**
   * The values bound finer cells (a split node cut at `maxZoom`) instead of
   * holding over the whole cell.
   */
  bound: boolean;
}

/**
 * The pyramid cells inside tile (z, x, y), no finer than `maxZoom`. A split
 * node at `maxZoom` answers with its own values, which bound its children:
 * the shallowest depth, the widest σ and every flag. Cells the index never
 * stored come back as NO_DATA. A tile finer than the stored leaf it lies in
 * is one cell with that leaf's values.
 */
export function cellsInTile(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  maxZoom: number
): TileCell[] {
  const out: TileCell[] = [];
  const limit = Math.min(maxZoom, store.leafZoom);
  const visit = (cz: number, cx: number, cy: number): void => {
    if (cz < store.minZoom) {
      for (const [dx, dy] of CHILDREN) {
        visit(cz + 1, 2 * cx + dx, 2 * cy + dy);
      }
      return;
    }
    const i = store.find(cz, cx, cy);
    if (i < 0) {
      out.push({ z: cz, x: cx, y: cy, values: NO_DATA, bound: false });
      return;
    }
    if (!store.isSplit(i) || cz >= limit) {
      out.push({ z: cz, x: cx, y: cy, values: store.values(i), bound: store.isSplit(i) });
      return;
    }
    for (const [dx, dy] of CHILDREN) {
      visit(cz + 1, 2 * cx + dx, 2 * cy + dy);
    }
  };
  if (z <= store.minZoom) {
    visit(z, x, y);
    return out;
  }
  // A coarser leaf may hold the whole tile; the tile then takes its values.
  for (let az = Math.min(z, store.leafZoom); az >= store.minZoom; az--) {
    const shift = z - az;
    const i = store.find(az, Math.floor(x / 2 ** shift), Math.floor(y / 2 ** shift));
    if (i < 0) {
      continue;
    }
    if (az === z) {
      visit(z, x, y);
    } else if (!store.isSplit(i) || az >= limit) {
      out.push({ z, x, y, values: store.values(i), bound: store.isSplit(i) });
    } else {
      out.push({ z, x, y, values: NO_DATA, bound: false });
    }
    return out;
  }
  out.push({ z, x, y, values: NO_DATA, bound: false });
  return out;
}

const CHILDREN = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1]
] as const;
