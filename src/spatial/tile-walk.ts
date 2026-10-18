import { tileKey } from "../foundation/geo";
import type { NodeStore, NodeValues } from "./node-store";
import { combine, NO_DATA } from "./node-store";

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
 *
 * Living-chart adjustments are folded into the cells they fall in, so no two
 * cells overlap and each area has one value. A cell coarser than the
 * living-chart zoom is split down to it; at `maxZoom` it takes the bound of
 * its chart value and every adjustment inside it.
 */
export function cellsInTile(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  maxZoom: number
): TileCell[] {
  const chart = chartCells(store, z, x, y, maxZoom);
  const adjusted = adjustmentsIn(store, z, x, y);
  if (adjusted.length === 0) {
    return chart;
  }
  return chart.flatMap((c) => withAdjustments(c, adjusted, store.adjustZoom, maxZoom));
}

/** A living-chart cell at the store's `adjustZoom`. */
interface Adjusted {
  x: number;
  y: number;
  values: NodeValues;
}

function adjustmentsIn(store: NodeStore, z: number, x: number, y: number): Adjusted[] {
  const az = store.adjustZoom;
  if (store.adjustments.size === 0) {
    return [];
  }
  if (z >= az) {
    const shift = 2 ** (z - az);
    const ax = Math.floor(x / shift);
    const ay = Math.floor(y / shift);
    const values = store.adjustments.get(tileKey(az, ax, ay));
    return values ? [{ x: ax, y: ay, values }] : [];
  }
  const scale = 2 ** (az - z);
  const n = 2 ** az;
  const out: Adjusted[] = [];
  for (const [key, values] of store.adjustments) {
    const ax = Math.floor(key / n);
    const ay = key % n;
    if (Math.floor(ax / scale) === x && Math.floor(ay / scale) === y) {
      out.push({ x: ax, y: ay, values });
    }
  }
  return out;
}

/** The adjustments that cover cell `c` or lie inside it. */
function touching(c: TileCell, list: readonly Adjusted[], az: number): Adjusted[] {
  if (c.z >= az) {
    const s = 2 ** (c.z - az);
    return list.filter((a) => a.x === Math.floor(c.x / s) && a.y === Math.floor(c.y / s));
  }
  const s = 2 ** (az - c.z);
  return list.filter((a) => Math.floor(a.x / s) === c.x && Math.floor(a.y / s) === c.y);
}

function withAdjustments(
  c: TileCell,
  list: readonly Adjusted[],
  az: number,
  maxZoom: number
): TileCell[] {
  const here = touching(c, list, az);
  if (here.length === 0) {
    return [c];
  }
  if (c.z >= az) {
    // At or below the living-chart zoom one adjustment covers the whole cell.
    return [{ ...c, values: combine(c.values, (here[0] as Adjusted).values) }];
  }
  if (c.z >= maxZoom) {
    const values = here.reduce((v, a) => combine(v, a.values), c.values);
    return [{ ...c, values, bound: true }];
  }
  // The chart value holds over each child, or bounds it when `c` is a bound.
  return CHILDREN.flatMap(([dx, dy]) =>
    withAdjustments({ ...c, z: c.z + 1, x: 2 * c.x + dx, y: 2 * c.y + dy }, here, az, maxZoom)
  );
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
