import type { Rect } from "../foundation/geo";
import { rectGap, tileRect, tileSize } from "../foundation/geo";
import { chartReach, flagReach, reachersOf } from "../spatial/chart-position";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { FLAGS } from "../spatial/node-store";
import { cellsInTile } from "../spatial/tile-walk";

/** Cells per tile side at most: 2^6 = 64. */
export const DETAIL_ZOOMS = 6;

/** Cells per tile side of the reach grid: one per drawing cell at the finest zoom. */
export const SLOTS = 2 ** DETAIL_ZOOMS;

/** Uint32 words of one flag mask: a bit per slot, row by row from the north edge. */
export const MASK_WORDS = (SLOTS * SLOTS) / 32;

/** An array of indexes into a table: 16 bits wherever the table is small enough. */
export type IndexArray = Uint16Array | Uint32Array;

/** `values`, each below `count`, as the narrowest index array that holds them. */
function indexes(values: ArrayLike<number>, count: number): IndexArray {
  return count <= 0x10000 ? Uint16Array.from(values) : Uint32Array.from(values);
}

/** An index array of `length` entries for a table of `count`, to be filled in place. */
function indexArray(length: number, count: number): IndexArray {
  return count <= 0x10000 ? new Uint16Array(length) : new Uint32Array(length);
}

const f32 = new Float32Array(1);
const f32Bits = new Int32Array(f32.buffer);

/** The greatest float32 at most `v`: a float32 stored for `v` never lies above it. */
export function floor32(v: number): number {
  f32[0] = v;
  const f = f32[0] as number;
  if (!(f > v)) {
    return f;
  }
  // One float32 step toward -Infinity: the bit pattern counts away from zero.
  f32Bits[0] = (f32Bits[0] as number) + (f > 0 ? -1 : 1);
  return f32[0] as number;
}

/** The least float32 at least `v`. */
export function ceil32(v: number): number {
  return -floor32(-v);
}

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
  cellKind: IndexArray;
  /**
   * Per source: its kind (a survey depth, or land placed by its own σ), the
   * entry of `sigmas` holding its position σ, and four entries of
   * `sourceRect`: its west, north, east and south edges in slots from the
   * tile's west and north edges. The edges are float32 rounded outward (west
   * and north down, east and south up), which only widens a source: no slot
   * is further from it, so no class is lowered (invariant 2).
   */
  sourceKind: IndexArray;
  sourceSigma: IndexArray;
  sourceRect: Float32Array;
  /** The distinct source σ in metres. */
  sigmas: Float64Array;
  /** Slots per ground metre at the poleward edge of the tile's reach, as for every source. */
  sourceScale: number;
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
  const cellKind = new Array<number>(n);
  cells.forEach((c, i) => {
    const scale = 2 ** (c.z - z);
    cellZ[i] = c.z - z;
    cellX[i] = c.x - x * scale;
    cellY[i] = c.y - y * scale;
    cellKind[i] = kinds.of(c.values, c.bound);
  });
  const reach = reachOf(store, z, x, y, kinds);
  return {
    ...kinds.columns(),
    cellZ,
    cellX,
    cellY,
    cellKind: indexes(cellKind, kinds.count),
    ...reach
  };
}

/** Bytes of a geometry's columns. */
export function geometryBytes(g: TileGeometry): number {
  return Object.values(g).reduce(
    (sum: number, a: ArrayBufferView | number) => sum + (typeof a === "number" ? 8 : a.byteLength),
    0
  );
}

class Kinds {
  /** Kinds by dMin; a Map key takes -0 as 0, so dMin is compared again with Object.is. */
  private readonly byDepth = new Map<number, number[]>();
  private readonly values: [NodeValues, boolean][] = [];

  get count(): number {
    return this.values.length;
  }

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
  "sourceKind" | "sourceSigma" | "sigmas" | "sourceScale" | "sourceRect" | "flagKind" | "flagMask"
>;

/** West, north, east and south edges in slots. */
type Box = [number, number, number, number];

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
 * Slots past the tile's edges that `edges` looks at, at most: CATZOC C's
 * reach at z18 near 60° N, so its grid stays within a few megabytes at any
 * zoom.
 */
export const EDGE_MARGIN = 16 * SLOTS;

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
    out.push(...(group.length < 9 ? group : edgesOf(group)));
  }
  return out;
}

/**
 * The edge sources of one group. Only slots within its reach of the tile, or
 * EDGE_MARGIN, are tested: a coarse leaf among fine ones is cut to them
 * rather than held whole, and a source whose ring leaves them is kept, which
 * never lowers a slot.
 */
function edgesOf(group: Gathered[]): Gathered[] {
  const { sigma, scale } = group[0] as Gathered;
  const margin = Math.ceil(Math.min(chartReach(sigma) * scale, EDGE_MARGIN)) + 1;
  const lo = -margin;
  const hi = SLOTS + margin;
  const box = group.map((g) => g.r.map(Math.round) as Box);
  const cut = box
    .map(([a, b, c, d]): Box => [
      Math.max(a, lo),
      Math.max(b, lo),
      Math.min(c, hi),
      Math.min(d, hi)
    ])
    .filter(([a, b, c, d]) => a < c && b < d);
  if (cut.length === 0) {
    return group;
  }
  // One pass: spreading a group of many sources into Math.min/max can pass the argument limit.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [a, b, c, d] of cut) {
    x0 = Math.min(x0, a - 1);
    y0 = Math.min(y0, b - 1);
    x1 = Math.max(x1, c + 1);
    y1 = Math.max(y1, d + 1);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const held = new Uint8Array(w * h);
  for (const [a, b, c, d] of cut) {
    for (let j = b; j < d; j++) {
      held.fill(1, (j - y0) * w + (a - x0), (j - y0) * w + (c - x0));
    }
  }
  const inner = ([a, b, c, d]: Box): boolean => {
    // A ring past the grid reaches slots it does not hold: kept.
    if (a - 1 < x0 || b - 1 < y0 || c >= x0 + w || d >= y0 + h) {
      return false;
    }
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
  return group.filter((_, n) => !inner(box[n] as Box));
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
    if (r.topoSigma > 0 && r.topoDMin === -Infinity) {
      add(kinds.of(LAND, false), r.topoSigma);
    } else if (r.topoSigma > 0 && r.topoDMin !== Infinity) {
      const v = { ...LAND, dMin: r.topoDMin, sigmaD: r.values.sigmaD };
      add(kinds.of(v, r.bound), r.topoSigma);
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
  return {
    ...packSources(edges(joined(joined(gathered, 0), 1)), kinds),
    flagKind: Uint32Array.from(used, ([k]) => k),
    flagMask
  };
}

/** The columns of `sources`: kinds and σ as indexes, edges as float32 rounded outward. */
function packSources(
  sources: Gathered[],
  kinds: Kinds
): Pick<Reach, "sourceKind" | "sourceSigma" | "sigmas" | "sourceScale" | "sourceRect"> {
  const sigmas = new Map<number, number>();
  for (const g of sources) {
    if (!sigmas.has(g.sigma)) {
      sigmas.set(g.sigma, sigmas.size);
    }
  }
  const rect = new Float32Array(4 * sources.length);
  const sourceKind = indexArray(sources.length, kinds.count);
  const sourceSigma = indexArray(sources.length, sigmas.size);
  sources.forEach(({ k, sigma, r }, i) => {
    rect[4 * i] = floor32(r[0]);
    rect[4 * i + 1] = floor32(r[1]);
    rect[4 * i + 2] = ceil32(r[2]);
    rect[4 * i + 3] = ceil32(r[3]);
    sourceKind[i] = k;
    sourceSigma[i] = sigmas.get(sigma) as number;
  });
  return {
    sourceKind,
    sourceSigma,
    sigmas: Float64Array.from(sigmas.keys()),
    // reachersOf gives every source of a tile the same perMetre.
    sourceScale: sources[0]?.scale ?? 0,
    sourceRect: rect
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
