import { tileKey } from "../foundation/geo";
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
  return [...chartCells(store, z, x, y, maxZoom), ...adjustedCells(store, z, x, y)];
}

/**
 * Living-chart cells inside the tile, listed after the charted cells so they
 * draw over them. A tile finer than the living-chart zoom is one cell when
 * the adjusted cell it lies in exists.
 */
function adjustedCells(store: NodeStore, z: number, x: number, y: number): TileCell[] {
  const az = store.adjustZoom;
  if (store.adjustments.size === 0) {
    return [];
  }
  if (z >= az) {
    const shift = 2 ** (z - az);
    const v = store.adjustments.get(tileKey(az, Math.floor(x / shift), Math.floor(y / shift)));
    return v ? [{ z, x, y, values: v, bound: false }] : [];
  }
  const scale = 2 ** (az - z);
  const n = 2 ** az;
  const out: TileCell[] = [];
  for (const [key, values] of store.adjustments) {
    const cx = Math.floor(key / n);
    const cy = key % n;
    if (Math.floor(cx / scale) === x && Math.floor(cy / scale) === y) {
      out.push({ z: az, x: cx, y: cy, values, bound: false });
    }
  }
  return out;
}

function chartCells(
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
