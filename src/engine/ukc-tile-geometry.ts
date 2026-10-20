import type { Rect } from "../foundation/geo";
import { rectGap, tileRect, tileSize } from "../foundation/geo";
import type { Reacher } from "../spatial/chart-position";
import { reachersOf } from "../spatial/chart-position";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";
import type { Adjusted } from "../spatial/tile-walk";
import { adjustmentsIn, cellsInTile } from "../spatial/tile-walk";

/** Cells per tile side at most: 2^6 = 64. */
export const DETAIL_ZOOMS = 6;

/** Cells per tile side of the reach grid: one per drawing cell at the finest zoom. */
export const SLOTS = 2 ** DETAIL_ZOOMS;

/** Uint32 words of one reach mask: a bit per slot, row by row from the north edge. */
export const MASK_WORDS = (SLOTS * SLOTS) / 32;

/**
 * What a UKC tile is drawn from that the water level, draft and σ leave
 * unchanged (plan §4.10): the pyramid cells in the tile, and the slots of
 * the SLOTS × SLOTS reach grid that each reaching cell's chart reach covers.
 * Cells and reachers with the same values share a kind, so a request classes
 * each kind once; a tile over the Nauvo charts holds 5 to 17 kinds.
 */
export interface TileGeometry {
  /** Per kind: the values its class depends on. */
  dMin: Float64Array;
  sigmaD: Float64Array;
  flags: Uint16Array;
  /** 1 for a split node's bound (TileCell.bound). */
  bound: Uint8Array;
  /** Per cell, in cellsInTile order: zoom below the tile's, column and row inside it, kind. */
  cellZ: Uint8Array;
  cellX: Uint16Array;
  cellY: Uint16Array;
  cellKind: Uint32Array;
  /** The kinds whose reach covers some slot; kind reachKind[m] covers mask m. */
  reachKind: Uint32Array;
  /** MASK_WORDS words per entry of reachKind. */
  reachMask: Uint32Array;
}

/** The geometry of tile (z, x, y), walked from the store and its living-chart cells. */
export function tileGeometry(store: NodeStore, z: number, x: number, y: number): TileGeometry {
  const kinds = new Kinds();
  const cells = cellsInTile(store, z, x, y, z + DETAIL_ZOOMS);
  const n = cells.length;
  const cellZ = new Uint8Array(n);
  const cellX = new Uint16Array(n);
  const cellY = new Uint16Array(n);
  const cellKind = new Uint32Array(n);
  cells.forEach((c, i) => {
    const scale = 2 ** (c.z - z);
    cellZ[i] = c.z - z;
    cellX[i] = c.x - x * scale;
    cellY[i] = c.y - y * scale;
    cellKind[i] = kinds.of(c.values, c.bound);
  });
  const { reachKind, reachMask } = reachMasks(store, z, x, y, kinds);
  return { ...kinds.columns(), cellZ, cellX, cellY, cellKind, reachKind, reachMask };
}

/** Bytes of a geometry's columns. */
export function geometryBytes(g: TileGeometry): number {
  return Object.values(g).reduce((sum: number, a: ArrayBufferView) => sum + a.byteLength, 0);
}

class Kinds {
  /** Kinds by dMin; a Map key takes -0 as 0, so dMin is compared again with Object.is. */
  private readonly byDepth = new Map<number, number[]>();
  private readonly values: [NodeValues, boolean][] = [];

  of(v: NodeValues, bound: boolean): number {
    let list = this.byDepth.get(v.dMin);
    if (!list) {
      list = [];
      this.byDepth.set(v.dMin, list);
    }
    for (const k of list) {
      const [w, b] = this.values[k] as [NodeValues, boolean];
      if (
        b === bound &&
        w.sigmaD === v.sigmaD &&
        w.flags === v.flags &&
        Object.is(w.dMin, v.dMin)
      ) {
        return k;
      }
    }
    const k = this.values.length;
    list.push(k);
    this.values.push([v, bound]);
    return k;
  }

  columns(): Pick<TileGeometry, "dMin" | "sigmaD" | "flags" | "bound"> {
    const all = this.values;
    return {
      dMin: Float64Array.from(all, ([v]) => v.dMin),
      sigmaD: Float64Array.from(all, ([v]) => v.sigmaD),
      flags: Uint16Array.from(all, ([v]) => v.flags),
      bound: Uint8Array.from(all, ([, b]) => (b ? 1 : 0))
    };
  }
}

function reachMasks(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  kinds: Kinds
): Pick<TileGeometry, "reachKind" | "reachMask"> {
  const tile = tileRect(z, x, y);
  const slot = tileSize(z) / SLOTS;
  const masks = new Map<number, Uint32Array>();
  for (const r of reachersOf(store, tile, DEFAULT_BUILD.k, z + DETAIL_ZOOMS)) {
    const k = kinds.of(r.values, r.bound);
    let mask = masks.get(k);
    if (!mask) {
      mask = new Uint32Array(MASK_WORDS);
      masks.set(k, mask);
    }
    cover(mask, r, tile, slot);
  }
  const used = [...masks].filter(([, m]) => m.some((w) => w !== 0));
  const reachMask = new Uint32Array(used.length * MASK_WORDS);
  used.forEach(([, m], i) => reachMask.set(m, i * MASK_WORDS));
  return { reachKind: Uint32Array.from(used, ([k]) => k), reachMask };
}

/**
 * Sets in `mask` the slots within `r.reach` of `r.rect`. Along a row the gap
 * is the larger of a rising and a falling term, so the slots within reach
 * are one run: found from both ends, they need no test in between.
 */
function cover(mask: Uint32Array, r: Reacher, tile: Rect, slot: number): void {
  const clamp = (v: number): number => Math.max(0, Math.min(SLOTS - 1, Math.floor(v)));
  const i0 = clamp((r.rect.minX - r.reach - tile.minX) / slot);
  const i1 = clamp((r.rect.maxX + r.reach - tile.minX) / slot);
  const j0 = clamp((tile.maxY - r.rect.maxY - r.reach) / slot);
  const j1 = clamp((tile.maxY - r.rect.minY + r.reach) / slot);
  const s = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const within = (i: number): boolean => {
    s.minX = tile.minX + i * slot;
    s.maxX = s.minX + slot;
    return rectGap(s, r.rect) <= r.reach;
  };
  for (let j = j0; j <= j1; j++) {
    s.maxY = tile.maxY - j * slot;
    s.minY = s.maxY - slot;
    let a = i0;
    while (a <= i1 && !within(a)) {
      a++;
    }
    let b = i1;
    while (b > a && !within(b)) {
      b--;
    }
    for (let k = j * SLOTS + a, end = j * SLOTS + b; k <= end;) {
      const lo = k & 31;
      const hi = Math.min(31, lo + end - k);
      mask[k >>> 5] = (mask[k >>> 5] as number) | ((0xffffffff >>> (31 - (hi - lo))) << lo);
      k += hi - lo + 1;
    }
  }
}

/** Default byte budget of a UkcTileCache. */
export const TILE_CACHE_BYTES = 8 * 2 ** 20;

/** Bytes an entry costs besides its columns: its objects, typed-array headers and Map slot. */
const ENTRY_BYTES = 3072;

interface Entry {
  geometry: TileGeometry;
  /** The living-chart cells the geometry was walked with. */
  adjusted: Adjusted[];
  /** `store.adjustments.revision` they were last found unchanged at. */
  revision: number;
  bytes: number;
}

/**
 * Tile geometries by (z, x, y), least recently used dropped first beyond
 * `maxBytes`. An entry holds for one store and the living-chart cells in its
 * tile: another store (a handover or a WFS rebuild) empties the cache, and a
 * write to the store's adjustments has each entry compare the cells in its
 * tile before it is used again (invariant 5).
 */
export class UkcTileCache {
  bytes = 0;
  private store: WeakRef<NodeStore> | undefined;
  private count = -1;
  private loads = 0;
  private readonly entries = new Map<string, Entry>();

  constructor(readonly maxBytes = TILE_CACHE_BYTES) {}

  get size(): number {
    return this.entries.size;
  }

  geometry(store: NodeStore, z: number, x: number, y: number): TileGeometry {
    if (this.store?.deref() !== store || this.count !== store.count) {
      this.entries.clear();
      this.bytes = 0;
      this.store = new WeakRef(store);
      this.count = store.count;
      this.loads = store.loadRevision;
    }
    if (store.loadRevision !== this.loads) {
      // A tile walked over a block read from its stand-ins is safe but no longer what the
      // loaded block gives; a block dropped since reads its stand-ins again.
      this.dropOver(store.blocksChangedSince(this.loads));
      this.loads = store.loadRevision;
    }
    const key = `${z}/${x}/${y}`;
    const revision = store.adjustments.revision;
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.bytes -= hit.bytes;
      if (hit.revision === revision || sameCells(hit.adjusted, adjustmentsIn(store, z, x, y))) {
        hit.revision = revision;
        this.keep(key, hit);
        return hit.geometry;
      }
    }
    const adjusted = adjustmentsIn(store, z, x, y);
    const geometry = tileGeometry(store, z, x, y);
    this.keep(key, {
      geometry,
      adjusted,
      revision,
      bytes: geometryBytes(geometry) + ENTRY_BYTES + adjusted.length * 64
    });
    return geometry;
  }

  private dropOver(blocks: readonly { z: number; x: number; y: number }[]): void {
    if (blocks.length === 0) {
      return;
    }
    const changed = new Set(blocks.map((b) => `${b.z}/${b.x}/${b.y}`));
    const bz = blocks[0]?.z ?? 0;
    for (const [key, e] of this.entries) {
      const [z, x, y] = key.split("/").map(Number) as [number, number, number];
      const hit =
        z >= bz
          ? changed.has(`${bz}/${x >> (z - bz)}/${y >> (z - bz)}`)
          : blocks.some((b) => b.x >> (bz - z) === x && b.y >> (bz - z) === y);
      if (hit) {
        this.entries.delete(key);
        this.bytes -= e.bytes;
      }
    }
  }

  private keep(key: string, entry: Entry): void {
    if (entry.bytes > this.maxBytes) {
      return;
    }
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    for (const [k, e] of this.entries) {
      if (this.bytes <= this.maxBytes) {
        break;
      }
      this.entries.delete(k);
      this.bytes -= e.bytes;
    }
  }
}

function sameCells(a: readonly Adjusted[], b: readonly Adjusted[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.x === b[i]?.x && c.y === b[i]?.y && c.values === b[i]?.values)
  );
}
