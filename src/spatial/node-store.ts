import { tileKey } from "../foundation/geo";

/** Bit flags carried by every pyramid node (plan §4.3). Parents OR their children's. */
export const FLAGS = {
  SWEPT: 1,
  NO_COVERAGE: 2,
  UNASSESSED: 4,
  DREDGED: 8,
  LIVECHART_ADJUSTED: 16
} as const;

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
  flags: FLAGS.NO_COVERAGE,
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

/**
 * Sparse quadtree storage. A node is stored for every evaluated tile; a node
 * whose `split` bit is clear has no children and its values hold exactly for
 * its whole tile. Columns are typed arrays so a large index stays compact.
 */
export class NodeStore {
  readonly minZoom: number;
  readonly leafZoom: number;
  private readonly levels: Map<number, number>[];
  count = 0;
  dMin = new Float64Array(1024);
  sigmaD = new Float32Array(1024);
  sigmaP = new Float32Array(1024);
  flags = new Uint16Array(1024);
  cellRef = new Int32Array(1024);
  split = new Uint8Array(1024);

  constructor(minZoom: number, leafZoom: number) {
    if (!(minZoom >= 0 && leafZoom >= minZoom && leafZoom <= 26)) {
      throw new Error(`invalid zoom range ${minZoom}..${leafZoom}`);
    }
    this.minZoom = minZoom;
    this.leafZoom = leafZoom;
    this.levels = Array.from({ length: leafZoom - minZoom + 1 }, () => new Map());
  }

  private grow(): void {
    const cap = this.dMin.length * 2;
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
    this.flags = g(this.flags, (n) => new Uint16Array(n));
    this.cellRef = g(this.cellRef, (n) => new Int32Array(n));
    this.split = g(this.split, (n) => new Uint8Array(n));
  }

  private level(z: number): Map<number, number> {
    const level = this.levels[z - this.minZoom];
    if (!level) {
      throw new Error(`zoom ${z} outside ${this.minZoom}..${this.leafZoom}`);
    }
    return level;
  }

  add(z: number, x: number, y: number, v: NodeValues, split: boolean): number {
    if (this.count === this.dMin.length) {
      this.grow();
    }
    const i = this.count++;
    this.dMin[i] = v.dMin;
    this.sigmaD[i] = v.sigmaD;
    this.sigmaP[i] = v.sigmaP;
    this.flags[i] = v.flags;
    this.cellRef[i] = v.cellRef;
    this.split[i] = split ? 1 : 0;
    this.level(z).set(tileKey(z, x, y), i);
    return i;
  }

  /** Node index of tile (z, x, y), or -1 when it was never stored. */
  find(z: number, x: number, y: number): number {
    if (z < this.minZoom || z > this.leafZoom) {
      return -1;
    }
    return this.level(z).get(tileKey(z, x, y)) ?? -1;
  }

  values(i: number): NodeValues {
    return {
      dMin: this.dMin[i] ?? -Infinity,
      sigmaD: this.sigmaD[i] ?? 0,
      sigmaP: this.sigmaP[i] ?? 0,
      flags: this.flags[i] ?? FLAGS.NO_COVERAGE,
      cellRef: this.cellRef[i] ?? -1
    };
  }

  isSplit(i: number): boolean {
    return this.split[i] === 1;
  }

  /** Every stored tile at zoom z as [x, y, nodeIndex]. */
  *entries(z: number): Generator<[number, number, number]> {
    const n = 2 ** z;
    for (const [key, i] of this.level(z)) {
      yield [Math.floor(key / n), key % n, i];
    }
  }
}
