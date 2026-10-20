import type { Rect } from "../foundation/geo";
import {
  emptyRect,
  expandRect,
  extendRect,
  groundToMercator,
  maxAbsLat,
  rectsOverlap,
  tileRange,
  tileRect
} from "../foundation/geo";
import type { BuildOptions, CellReach, Item } from "./build-items";
import type { NodeColumns } from "./node-store";
import type { RootRange } from "./pyramid-build";
import { buildRoots } from "./pyramid-build";
import type { NodeStore } from "./node-store";
import { bodyColumns, pyramidColumns, storeOnBody } from "./store";

/**
 * The pyramid built one column of minZoom roots at a time, each from only the
 * cells that can reach it (plan §4.3). A root depends only on the items that
 * reach it, so the columns joined in order are the pyramid a build of all
 * cells at once makes, while only one neighbourhood's features are held.
 */

/** The roots over all cells' coverage: the range `rootRange` finds from their items. */
export function cellsRootRange(
  reaches: readonly CellReach[],
  minZoom: number
): RootRange | undefined {
  const extent = emptyRect();
  for (const { coverage } of reaches) {
    if (coverage.minX <= coverage.maxX) {
      extendRect(extent, coverage.minX, coverage.minY);
      extendRect(extent, coverage.maxX, coverage.maxY);
    }
  }
  return extent.minX > extent.maxX ? undefined : tileRange(minZoom, extent);
}

/** One region per root, column by column, in the order `buildRoots` evaluates them. */
export function rootRegions(range: RootRange): RootRange[] {
  const out: RootRange[] = [];
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      out.push({ minX: x, minY: y, maxX: x, maxY: y });
    }
  }
  return out;
}

/** Absorbs rounding where the region's latitude scale is compared with a root's. */
const REACH_MARGIN = 1;

/**
 * Catalogue indices of the cells whose features can reach a root of
 * `region`. A root takes an item only where the item's box meets the root
 * grown by the item's burn radius at the root's latitude; every root lies in
 * the region, nearer the equator than its poleward edge.
 */
export function cellsReaching(
  region: RootRange,
  minZoom: number,
  reaches: readonly CellReach[]
): number[] {
  const nw = tileRect(minZoom, region.minX, region.minY);
  const se = tileRect(minZoom, region.maxX, region.maxY);
  const rect: Rect = { minX: nw.minX, minY: se.minY, maxX: se.maxX, maxY: nw.maxY };
  const scale = groundToMercator(1, maxAbsLat(rect));
  return reaches.flatMap((r, i) =>
    rectsOverlap(expandRect(rect, r.radius * scale + REACH_MARGIN), r.box) ? [i] : []
  );
}

/**
 * One region's nodes from its items, prepared from the features of the cells
 * reaching it in catalogue order. Area rings live on only in the items' indexed
 * shapes, so the features need not be held while the region builds.
 */
export function buildRegion(items: Item[], opts: BuildOptions, region: RootRange): NodeColumns {
  return pyramidColumns(buildRoots(items, opts, region));
}

/** The nodes built for one region of roots. */
export interface RegionPart {
  region: RootRange;
  cols: NodeColumns;
}

/**
 * Copies, from each part of one column in row order, its run of nodes at
 * zoom z in tile column x, for each x the parts hold; returns where it ended.
 */
function joinColumn(
  z: number,
  parts: RegionPart[],
  cursor: number[],
  out: NodeColumns,
  at: number
): number {
  const n = 2 ** z;
  const has = (k: number): boolean => {
    const p = (parts[k] as RegionPart).cols;
    return (cursor[k] as number) < p.z.length && p.z[cursor[k] as number] === z;
  };
  for (;;) {
    let x = Infinity;
    parts.forEach((p, k) => {
      x = has(k) ? Math.min(x, Math.floor((p.cols.key[cursor[k] as number] as number) / n)) : x;
    });
    if (x === Infinity) {
      return at;
    }
    const end = (x + 1) * n;
    parts.forEach((p, k) => {
      const from = cursor[k] as number;
      let to = from;
      while (to < p.cols.z.length && p.cols.z[to] === z && (p.cols.key[to] as number) < end) {
        to++;
      }
      for (const c of Object.keys(out) as (keyof NodeColumns)[]) {
        (out[c] as Float64Array).set((p.cols[c] as Float64Array).subarray(from, to), at);
      }
      at += to - from;
      cursor[k] = to;
    });
  }
}

/**
 * One store from the parts built for single-column regions of roots, given
 * column by column and, within a column, row by row. At every zoom a later
 * column's tiles have larger keys; within a column the rows' tiles interleave
 * by tile column, and are copied in that order. The result is the store a
 * build of all the roots at once makes.
 */
export function joinRegions(minZoom: number, leafZoom: number, parts: RegionPart[]): NodeStore {
  const { body, cols } = joinParts(minZoom, leafZoom, parts);
  return storeOnBody(minZoom, leafZoom, body, cols);
}

/** The columns `joinRegions` adopts, views on one buffer laid out as the file body. */
export function joinParts(
  minZoom: number,
  leafZoom: number,
  parts: RegionPart[]
): { body: Uint8Array; cols: NodeColumns } {
  parts.forEach(({ region: r }, k) => {
    const before = parts[k - 1]?.region;
    if (
      r.minX !== r.maxX ||
      (before && (before.minX > r.minX || (before.minX === r.minX && before.maxY >= r.minY)))
    ) {
      throw new Error("pyramid parts must be single columns of roots in column and row order");
    }
  });
  const total = parts.reduce((n, p) => n + p.cols.dMin.length, 0);
  const { body, cols } = bodyColumns(total);
  const cursor = parts.map(() => 0);
  let at = 0;
  const columns = [...new Set(parts.map((p) => p.region.minX))];
  for (let z = minZoom; z <= leafZoom; z++) {
    for (const x of columns) {
      const ks = parts.flatMap((p, k) => (p.region.minX === x ? [k] : []));
      const sub = ks.map((k) => cursor[k] as number);
      at = joinColumn(
        z,
        ks.map((k) => parts[k] as RegionPart),
        sub,
        cols,
        at
      );
      ks.forEach((k, j) => (cursor[k] = sub[j] as number));
    }
  }
  if (at !== total) {
    throw new Error("a pyramid part holds a zoom outside the range");
  }
  return { body, cols };
}
