import type { Rect } from "../foundation/geo";
import { rectGap, tileRect, tileSize } from "../foundation/geo";
import { chartReach, chartSigma, flagReach, reachersOf } from "../spatial/chart-position";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import { mercatorBuffer } from "../spatial/pyramid";
import type { Adjusted } from "../spatial/tile-walk";
import { adjustmentsIn, cellsInTile } from "../spatial/tile-walk";

/** Cells per tile side at most: 2^6 = 64. */
export const DETAIL_ZOOMS = 6;

/** Cells per tile side of the reach grid: one per drawing cell at the finest zoom. */
export const SLOTS = 2 ** DETAIL_ZOOMS;

/** Uint32 words of one flag mask: a bit per slot, row by row from the north edge. */
export const MASK_WORDS = (SLOTS * SLOTS) / 32;

/** Flags that keep a cell from reading clear (invariant 4). */
export const UNVERIFIED =
  FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

/**
 * What a UKC tile is drawn from that the water level, draft and σ leave
 * unchanged (plan §4.10): the pyramid cells in the tile; the cells whose
 * chart position reaches into it, as sources whose P is weighted by their
 * distance when the tile is drawn (`chart-position.ts`); and, per kind of
 * unverified cell, the slots of the SLOTS × SLOTS grid within its flag reach.
 * Cells and sources with the same values share a kind, so a request classes
 * each kind once.
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
  /**
   * Per source: its kind (a survey depth, or land placed by its own σ), its
   * position σ in metres, slots per ground metre at the poleward edge of its
   * reach, and four entries of `sourceRect`: its west, north, east and south
   * edges in slots from the tile's west and north edges.
   */
  sourceKind: Uint32Array;
  sourceSigma: Float64Array;
  sourceScale: Float64Array;
  sourceRect: Float64Array;
  /** The unverified kinds whose flag reach covers some slot; flagKind[m] covers mask m. */
  flagKind: Uint32Array;
  /** MASK_WORDS words per entry of flagKind. */
  flagMask: Uint32Array;
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
  const reach = reachOf(store, z, x, y, kinds);
  return { ...kinds.columns(), cellZ, cellX, cellY, cellKind, ...reach };
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

/** Land placed by its own σ, as a source kind: P = 1 wherever it lies. */
const LAND: NodeValues = { dMin: -Infinity, sigmaD: 0, sigmaP: 0, flags: 0, cellRef: -1 };

type Reach = Pick<
  TileGeometry,
  "sourceKind" | "sourceSigma" | "sourceScale" | "sourceRect" | "flagKind" | "flagMask"
>;

/** A source as gathered: kind, σ, slots per ground metre, and west, north, east, south in slots. */
interface Gathered {
  k: number;
  sigma: number;
  scale: number;
  r: [number, number, number, number];
}

/**
 * Sources of one kind, σ and scale that touch end to end along `axis` (0
 * west–east, 1 north–south) with the same extent across it, joined: the gap
 * from a slot to rectangles that touch so is the least of their gaps, and to
 * their union.
 */
function joined(list: Gathered[], axis: 0 | 1): Gathered[] {
  const lines = new Map<string, Gathered[]>();
  const across = 1 - axis;
  for (const g of list) {
    const key = `${g.k} ${g.sigma} ${g.scale} ${g.r[across]} ${g.r[across + 2]}`;
    const line = lines.get(key);
    if (line) {
      line.push(g);
    } else {
      lines.set(key, [g]);
    }
  }
  const out: Gathered[] = [];
  for (const line of lines.values()) {
    line.sort((a, b) => a.r[axis] - b.r[axis]);
    let run: Gathered | undefined;
    for (const g of line) {
      if (run && g.r[axis] === run.r[axis + 2]) {
        run.r[axis + 2] = Math.max(run.r[axis + 2] as number, g.r[axis + 2] as number);
      } else {
        run = { ...g, r: [...g.r] };
        out.push(run);
      }
    }
  }
  return out;
}

/**
 * The sources of each kind, σ and scale that touch the edge of their
 * union: one whose ring of slots all round is covered by others of its group
 * is left out. A slot outside the union is nearer an edge source than it,
 * and a slot inside it lies in a cell of the group, whose own P is at least
 * the P its depth spreads (its dMin is never deeper than its bathyDMin), so
 * the group never raises it. Sources are whole slots: a cell no finer than
 * the slots, on their grid.
 */
function edges(list: Gathered[]): Gathered[] {
  const groups = new Map<string, Gathered[]>();
  for (const g of list) {
    const key = `${g.k} ${g.sigma} ${g.scale}`;
    const group = groups.get(key);
    if (group) {
      group.push(g);
    } else {
      groups.set(key, [g]);
    }
  }
  const out: Gathered[] = [];
  for (const group of groups.values()) {
    if (group.length < 9) {
      out.push(...group);
      continue;
    }
    const box = group.map((g) => g.r.map(Math.round) as [number, number, number, number]);
    const x0 = Math.min(...box.map((b) => b[0])) - 1;
    const y0 = Math.min(...box.map((b) => b[1])) - 1;
    const w = Math.max(...box.map((b) => b[2])) + 1 - x0;
    const h = Math.max(...box.map((b) => b[3])) + 1 - y0;
    const held = new Uint8Array(w * h);
    for (const [a, b, c, d] of box) {
      for (let j = b; j < d; j++) {
        held.fill(1, (j - y0) * w + (a - x0), (j - y0) * w + (c - x0));
      }
    }
    const inner = ([a, b, c, d]: [number, number, number, number]): boolean => {
      for (let j = b - 1; j <= d; j++) {
        const row = (j - y0) * w - x0;
        const side = j === b - 1 || j === d;
        for (let i = a - 1; i <= c; i += side ? 1 : c - a + 1) {
          if (held[row + i] !== 1) {
            return false;
          }
        }
      }
      return true;
    };
    group.forEach((g, n) => {
      if (!inner(box[n] as [number, number, number, number])) {
        out.push(g);
      }
    });
  }
  return out;
}

function reachOf(store: NodeStore, z: number, x: number, y: number, kinds: Kinds): Reach {
  const tile = tileRect(z, x, y);
  const slot = tileSize(z) / SLOTS;
  const gathered: Gathered[] = [];
  const masks = new Map<number, Uint32Array>();
  for (const r of reachersOf(store, tile, z + DETAIL_ZOOMS)) {
    const add = (k: number, sigma: number): void => {
      gathered.push({
        k,
        sigma,
        scale: r.perMetre / slot,
        r: [
          (r.rect.minX - tile.minX) / slot,
          (tile.maxY - r.rect.maxY) / slot,
          (r.rect.maxX - tile.minX) / slot,
          (tile.maxY - r.rect.minY) / slot
        ]
      });
    };
    // A bound's flags hold NO_DEPTH when any cell under it has no depth;
    // its bathyDMin is Infinity only when none has any.
    if (r.surveySigma > 0 && r.bathyDMin !== Infinity) {
      const v = { ...LAND, dMin: r.bathyDMin, sigmaD: r.values.sigmaD };
      add(kinds.of(v, r.bound), r.surveySigma);
    }
    if (r.topoSigma > 0) {
      add(kinds.of(LAND, false), r.topoSigma);
    }
    if (r.surveySigma > 0 && (r.values.flags & UNVERIFIED) !== 0) {
      const k = kinds.of(r.values, r.bound);
      let mask = masks.get(k);
      if (!mask) {
        mask = new Uint32Array(MASK_WORDS);
        masks.set(k, mask);
      }
      cover(mask, r.rect, r.perMetre * flagReach(r.surveySigma), tile, slot);
    }
  }
  const used = [...masks].filter(([, m]) => m.some((w) => w !== 0));
  const flagMask = new Uint32Array(used.length * MASK_WORDS);
  used.forEach(([, m], i) => flagMask.set(m, i * MASK_WORDS));
  const sources = edges(joined(joined(gathered, 0), 1));
  return {
    sourceKind: Uint32Array.from(sources, (g) => g.k),
    sourceSigma: Float64Array.from(sources, (g) => g.sigma),
    sourceScale: Float64Array.from(sources, (g) => g.scale),
    sourceRect: Float64Array.from(sources.flatMap((g) => g.r)),
    flagKind: Uint32Array.from(used, ([k]) => k),
    flagMask
  };
}

/**
 * Sets in `mask` the slots within `reach` (Mercator) of `rect`. Along a row
 * the gap is the larger of a rising and a falling term, so the slots within
 * reach are one run: found from both ends, they need no test in between.
 */
function cover(mask: Uint32Array, rect: Rect, reach: number, tile: Rect, slot: number): void {
  const clamp = (v: number): number => Math.max(0, Math.min(SLOTS - 1, Math.floor(v)));
  const i0 = clamp((rect.minX - reach - tile.minX) / slot);
  const i1 = clamp((rect.maxX + reach - tile.minX) / slot);
  const j0 = clamp((tile.maxY - rect.maxY - reach) / slot);
  const j1 = clamp((tile.maxY - rect.minY + reach) / slot);
  const s = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const within = (i: number): boolean => {
    s.minX = tile.minX + i * slot;
    s.maxX = s.minX + slot;
    return rectGap(s, rect) <= reach;
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
    if (a > b) {
      continue;
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
      this.dropOver(store, store.blocksChangedSince(this.loads));
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

  private dropOver(store: NodeStore, blocks: readonly { z: number; x: number; y: number }[]): void {
    if (blocks.length === 0) {
      return;
    }
    // A tile's sources are cells up to the store's widest chart reach outside
    // it, scaled at the tile's own latitude as reachersOf scales it.
    const ground = chartReach(chartSigma(store).max);
    const near = blocks.map((b) => tileRect(b.z, b.x, b.y));
    for (const [key, e] of this.entries) {
      const [z, x, y] = key.split("/").map(Number) as [number, number, number];
      const tile = tileRect(z, x, y);
      const reach = mercatorBuffer(tile, ground);
      if (near.some((rect) => rectGap(tile, rect) <= reach)) {
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
