import { tileKey } from "../foundation/geo";

/** Bit flags carried by every pyramid node (plan §4.3). Parents OR their children's. */
export const FLAGS = {
  SWEPT: 1,
  NO_COVERAGE: 2,
  UNASSESSED: 4,
  DREDGED: 8,
  LIVECHART_ADJUSTED: 16,
  /** No charted depth at all in (part of) the tile; dMin is -Infinity there. */
  NO_DEPTH: 32,
  /** Set from a source licensed for non-navigational use only (the Traficom WFS). */
  NOT_FOR_NAVIGATION: 64
} as const;

const FLAG_NAMES: [number, string][] = [
  [FLAGS.SWEPT, "SWEPT"],
  [FLAGS.NO_COVERAGE, "NO_COVERAGE"],
  [FLAGS.UNASSESSED, "UNASSESSED"],
  [FLAGS.DREDGED, "DREDGED"],
  [FLAGS.LIVECHART_ADJUSTED, "LIVECHART_ADJUSTED"],
  [FLAGS.NOT_FOR_NAVIGATION, "NOT_FOR_NAVIGATION"]
];

/** Names of the flags a client should see (NO_DEPTH is internal). */
export function flagNames(flags: number): string[] {
  return FLAG_NAMES.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
}

export interface NodeValues {
  /** Conservative depth below chart datum (m); -Infinity for land or no data. */
  dMin: number;
  sigmaD: number;
  sigmaP: number;
  flags: number;
  /** Cell catalogue index of the feature that set dMin; -1 when none. */
  cellRef: number;
}

export const NO_DATA: NodeValues = {
  dMin: -Infinity,
  sigmaD: 0,
  sigmaP: 0,
  flags: FLAGS.NO_COVERAGE | FLAGS.NO_DEPTH,
  cellRef: -1
};

/** Folds `b` into `a`: the shallowest depth, the widest σ, the union of flags. */
export function combine(a: NodeValues, b: NodeValues): NodeValues {
  const deeper = b.dMin < a.dMin ? b : a;
  return {
    dMin: deeper.dMin,
    cellRef: deeper.cellRef,
    sigmaD: Math.max(a.sigmaD, b.sigmaD),
    sigmaP: Math.max(a.sigmaP, b.sigmaP),
    flags: a.flags | b.flags
  };
}

/** Identity element for `combine`. */
export const EMPTY: NodeValues = {
  dMin: Infinity,
  sigmaD: 0,
  sigmaP: 0,
  flags: 0,
  cellRef: -1
};

/** Zoom of living-chart cells (plan §4.13), capped at the leaf zoom. */
export const ADJUST_ZOOM = 18;

/**
 * One zoom level's tiles: tile keys and their node indices, searched by
 * bisection once sorted by key. A Map per level cost about 65 bytes of heap
 * per node and V8 refuses one beyond 16.7 M entries; these cost 12, and a
 * loaded level only the 8 of its key.
 */
interface Level {
  keys: Float64Array;
  /** Node index per key; undefined when key j belongs to node `offset + j`. */
  nodes: Int32Array | undefined;
  offset: number;
  n: number;
  /** Keys were added in increasing order, so `keys[0..n)` can be bisected. */
  sorted: boolean;
}

const emptyLevel = (): Level => ({
  keys: new Float64Array(0),
  nodes: new Int32Array(0),
  offset: 0,
  n: 0,
  sorted: true
});

const nodeAt = (level: Level, j: number): number =>
  level.nodes ? (level.nodes[j] as number) : level.offset + j;

function append(level: Level, key: number, node: number): void {
  if (level.n === level.keys.length || !level.nodes) {
    const keys = new Float64Array(Math.max(16, level.n * 2));
    const nodes = new Int32Array(keys.length);
    keys.set(level.keys.subarray(0, level.n));
    for (let j = 0; j < level.n; j++) {
      nodes[j] = nodeAt(level, j);
    }
    Object.assign(level, { keys, nodes, offset: 0 });
  }
  if (level.n > 0 && !(key > (level.keys[level.n - 1] as number))) {
    level.sorted = false;
  }
  level.keys[level.n] = key;
  (level.nodes as Int32Array)[level.n] = node;
  level.n++;
}

/** Orders the level by key; of a tile added more than once the last add stays, as in a Map. */
function sortLevel(level: Level): void {
  const order = Array.from({ length: level.n }, (_, j) => j).sort(
    (a, b) => (level.keys[a] as number) - (level.keys[b] as number) || a - b
  );
  const keys = new Float64Array(level.n);
  const nodes = new Int32Array(level.n);
  let n = 0;
  for (const j of order) {
    const key = level.keys[j] as number;
    n = n > 0 && keys[n - 1] === key ? n - 1 : n;
    keys[n] = key;
    nodes[n] = nodeAt(level, j);
    n++;
  }
  Object.assign(level, { keys, nodes, offset: 0, n, sorted: true });
}

/**
 * What a split node at a block store's cut zoom stands for while the block
 * holding its subtree is not loaded: with its own values (the subtree's
 * shallowest depth, widest σ and every flag) these bound what any query
 * over the subtree could read from it (`pyramid.ts`, `tile-walk.ts`).
 */
export interface StandIn {
  /** Shallowest dMin of the leaves under the node without NO_DEPTH; Infinity when none. */
  covered: number;
  /** Narrowest σD of those leaves. */
  sigmaDMin: number;
}

/**
 * The nodes finer than `cutZoom` of a store read from a file block by block
 * (`block-cache.ts`). Node indices it hands out are never reused, so one
 * held past an eviction reads as NO_DATA rather than as another tile.
 */
export interface BlockSource {
  readonly cutZoom: number;
  readonly blockZoom: number;
  /** Bumped whenever a block is loaded or dropped. */
  readonly revision: number;
  /** Tile keys at `blockZoom` of the blocks loaded or dropped after `revision`. */
  changedSince(revision: number): number[];
  find(z: number, x: number, y: number): number;
  values(i: number): NodeValues;
  isSplit(i: number): boolean;
  surveySigma(i: number): number;
  /** For split node i at (cutZoom, x, y): undefined once its block is loaded, else its stand-in. */
  standIn(i: number, x: number, y: number): StandIn | undefined;
  entries(z: number): Generator<[number, number, number]>;
}

/** The columns `NodeStore.fromColumns` adopts, one entry per node; `key` is the tileKey. */
export interface NodeColumns {
  z: Uint8Array;
  key: Float64Array;
  dMin: Float64Array;
  sigmaD: Float32Array;
  sigmaP: Float32Array;
  surveySigmaP: Float32Array;
  flags: Uint16Array;
  cellRef: Int32Array;
  split: Uint8Array;
}

/**
 * Sparse quadtree storage. A node is stored for every evaluated tile; a node
 * whose `split` bit is clear has no children and its values hold exactly for
 * its whole tile. Columns are typed arrays so a large index stays compact.
 */
export class NodeStore {
  readonly minZoom: number;
  readonly leafZoom: number;
  /**
   * Living-chart cells at `adjustZoom`, keyed by tileKey: values from own
   * soundings that queries take beside the charted ones. Taking them can
   * only lower a result's depth (safety invariant 5).
   */
  readonly adjustments = new Map<number, NodeValues>();
  private readonly levels: Level[];
  /** Nodes in the index, in this store's columns and in its blocks. */
  count = 0;
  /** Nodes in this store's own columns. */
  private own = 0;
  private source: BlockSource | undefined;
  dMin = new Float64Array(1024);
  sigmaD = new Float32Array(1024);
  sigmaP = new Float32Array(1024);
  /**
   * Widest σP of the assessed, non-advisory quality zones reaching the node
   * (for a split node, reaching any leaf under it): its chart position
   * reach. Unlike `sigmaP` it leaves out unassessed water's configured guess,
   * but not the assessed part of a leaf that is only partly assessed.
   */
  surveySigmaP = new Float32Array(1024);
  flags = new Uint16Array(1024);
  cellRef = new Int32Array(1024);
  split = new Uint8Array(1024);

  constructor(minZoom: number, leafZoom: number) {
    if (!(minZoom >= 0 && leafZoom >= minZoom && leafZoom <= 26)) {
      throw new Error(`invalid zoom range ${minZoom}..${leafZoom}`);
    }
    this.minZoom = minZoom;
    this.leafZoom = leafZoom;
    this.levels = Array.from({ length: leafZoom - minZoom + 1 }, emptyLevel);
  }

  /**
   * A store holding `cols` as its columns, without copying them. The nodes
   * must be grouped by zoom, coarsest first, as `serializePyramid` writes them
   * (also in key order, so no level needs a sort); anything else is refused.
   */
  static fromColumns(minZoom: number, leafZoom: number, cols: NodeColumns): NodeStore {
    const store = new NodeStore(minZoom, leafZoom);
    const count = cols.dMin.length;
    const { z: zs, key } = cols;
    let i = 0;
    store.levels.forEach((_, k) => {
      const start = i;
      let sorted = true;
      for (; i < count && zs[i] === minZoom + k; i++) {
        sorted &&= i === start || (key[i] as number) > (key[i - 1] as number);
      }
      const keys = key.subarray(start, i);
      store.levels[k] = { keys, nodes: undefined, offset: start, n: i - start, sorted };
    });
    if (i < count) {
      throw new Error(`pyramid node ${i} is at zoom ${zs[i]}, out of zoom order`);
    }
    Object.assign(store, {
      count,
      own: count,
      dMin: cols.dMin,
      sigmaD: cols.sigmaD,
      sigmaP: cols.sigmaP,
      surveySigmaP: cols.surveySigmaP,
      flags: cols.flags,
      cellRef: cols.cellRef,
      split: cols.split
    });
    return store;
  }

  /**
   * Hands the nodes finer than `source.cutZoom` to `source`; this store's
   * columns then hold the coarser ones and `total` is the index's node count.
   */
  attach(source: BlockSource, total: number): void {
    if (this.levels.slice(source.cutZoom + 1 - this.minZoom).some((l) => l.n > 0)) {
      throw new Error(`the store holds nodes finer than zoom ${source.cutZoom}`);
    }
    this.source = source;
    this.count = total;
  }

  /**
   * Bumped whenever a block is loaded or dropped; 0 for a store held whole.
   * A query over a block not loaded reads its stand-ins, so an answer cached
   * at one revision may differ at a later one, though only towards the loaded
   * answer, which a stand-in never reads safer than.
   */
  get loadRevision(): number {
    return this.source?.revision ?? 0;
  }

  /** The block tiles loaded or dropped since `loadRevision` was `revision`. */
  blocksChangedSince(revision: number): { z: number; x: number; y: number }[] {
    const s = this.source;
    if (!s) {
      return [];
    }
    const n = 2 ** s.blockZoom;
    return s
      .changedSince(revision)
      .map((key) => ({ z: s.blockZoom, x: Math.floor(key / n), y: key % n }));
  }

  get adjustZoom(): number {
    return Math.min(ADJUST_ZOOM, this.leafZoom);
  }

  private grow(): void {
    const cap = Math.max(1024, this.dMin.length * 2);
    const g = <T extends Float64Array | Float32Array | Uint16Array | Int32Array | Uint8Array>(
      a: T,
      make: (n: number) => T
    ): T => {
      const next = make(cap);
      next.set(a);
      return next;
    };
    this.dMin = g(this.dMin, (n) => new Float64Array(n));
    this.sigmaD = g(this.sigmaD, (n) => new Float32Array(n));
    this.sigmaP = g(this.sigmaP, (n) => new Float32Array(n));
    this.surveySigmaP = g(this.surveySigmaP, (n) => new Float32Array(n));
    this.flags = g(this.flags, (n) => new Uint16Array(n));
    this.cellRef = g(this.cellRef, (n) => new Int32Array(n));
    this.split = g(this.split, (n) => new Uint8Array(n));
  }

  private levelIndex(z: number): number {
    if (!(z >= this.minZoom && z <= this.leafZoom)) {
      throw new Error(`zoom ${z} outside ${this.minZoom}..${this.leafZoom}`);
    }
    return z - this.minZoom;
  }

  private level(z: number): Level {
    const level = this.levels[this.levelIndex(z)] as Level;
    if (!level.sorted) {
      sortLevel(level);
    }
    return level;
  }

  /** Stores tile (z, x, y); `split` marks a node whose children are stored too. */
  add(
    z: number,
    x: number,
    y: number,
    v: NodeValues,
    split: boolean,
    surveySigmaP: number
  ): number {
    const level = this.levels[this.levelIndex(z)] as Level;
    if (this.source) {
      throw new Error("a store read block by block takes no nodes");
    }
    if (this.count === this.dMin.length) {
      this.grow();
    }
    this.own++;
    const i = this.count++;
    this.dMin[i] = v.dMin;
    this.sigmaD[i] = v.sigmaD;
    this.sigmaP[i] = v.sigmaP;
    this.surveySigmaP[i] = surveySigmaP;
    this.flags[i] = v.flags;
    this.cellRef[i] = v.cellRef;
    this.split[i] = split ? 1 : 0;
    append(level, tileKey(z, x, y), i);
    return i;
  }

  /** Node index of tile (z, x, y), or -1 when it was never stored. */
  find(z: number, x: number, y: number): number {
    if (z < this.minZoom || z > this.leafZoom) {
      return -1;
    }
    if (this.source !== undefined && z > this.source.cutZoom) {
      return this.source.find(z, x, y);
    }
    const level = this.level(z);
    const keys = level.keys;
    const key = tileKey(z, x, y);
    let lo = 0;
    let hi = level.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = keys[mid] as number;
      if (k === key) {
        return nodeAt(level, mid);
      }
      // A NaN key compares false both ways and so ends unfound.
      if (k < key) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return -1;
  }

  /** Values of node i; an out-of-range index reads as NO_DATA, never as a depth. */
  values(i: number): NodeValues {
    if (!(i >= 0 && i < this.own)) {
      return this.source ? this.source.values(i) : { ...NO_DATA };
    }
    return {
      dMin: this.dMin[i] as number,
      sigmaD: this.sigmaD[i] as number,
      sigmaP: this.sigmaP[i] as number,
      flags: this.flags[i] as number,
      cellRef: this.cellRef[i] as number
    };
  }

  /** Whether node i's children are stored (its values are then bounds, not exact). */
  isSplit(i: number): boolean {
    return i < this.own ? this.split[i] === 1 : this.source?.isSplit(i) === true;
  }

  /** Node i's `surveySigmaP`; 0 for an index never handed out. */
  surveySigma(i: number): number {
    if (i >= 0 && i < this.own) {
      return this.surveySigmaP[i] as number;
    }
    return this.source ? this.source.surveySigma(i) : 0;
  }

  /**
   * For split node i at tile (z, x, y): what stands in for its children while
   * the block holding them is not loaded (a load is tried first), else
   * undefined. Only a store read block by block has any.
   */
  standIn(i: number, z: number, x: number, y: number): StandIn | undefined {
    const s = this.source;
    return s && z === s.cutZoom && i >= 0 && i < this.own && this.split[i] === 1
      ? s.standIn(i, x, y)
      : undefined;
  }

  /** Every stored tile at zoom z as [x, y, nodeIndex], in tile-key order. */
  *entries(z: number): Generator<[number, number, number]> {
    if (this.source && z > this.source.cutZoom) {
      yield* this.source.entries(z);
      return;
    }
    const n = 2 ** z;
    const level = this.level(z);
    for (let j = 0; j < level.n; j++) {
      const key = level.keys[j] as number;
      yield [Math.floor(key / n), key % n, nodeAt(level, j)];
    }
  }
}
