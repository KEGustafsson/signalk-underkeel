import { tileKey } from "../../src/foundation/geo";
import type { NodeValues } from "../../src/spatial/node-store";
import { NO_DATA } from "../../src/spatial/node-store";

/**
 * The node store as it was before IX-5, one Map per zoom level, kept so tests can
 * prove the sorted-array store finds the same nodes.
 */
const ADJUST_ZOOM = 18;

export class MapNodeStore {
  readonly minZoom: number;
  readonly leafZoom: number;
  /**
   * Living-chart cells at `adjustZoom`, keyed by tileKey: values from own
   * soundings that queries take beside the charted ones. Taking them can
   * only lower a result's depth (safety invariant 5).
   */
  readonly adjustments = new Map<number, NodeValues>();
  private readonly levels: Map<number, number>[];
  count = 0;
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
    this.levels = Array.from({ length: leafZoom - minZoom + 1 }, () => new Map());
  }

  get adjustZoom(): number {
    return Math.min(ADJUST_ZOOM, this.leafZoom);
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
    this.surveySigmaP = g(this.surveySigmaP, (n) => new Float32Array(n));
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

  /** Stores tile (z, x, y); `split` marks a node whose children are stored too. */
  add(
    z: number,
    x: number,
    y: number,
    v: NodeValues,
    split: boolean,
    surveySigmaP: number
  ): number {
    if (this.count === this.dMin.length) {
      this.grow();
    }
    const i = this.count++;
    this.dMin[i] = v.dMin;
    this.sigmaD[i] = v.sigmaD;
    this.sigmaP[i] = v.sigmaP;
    this.surveySigmaP[i] = surveySigmaP;
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

  /** Values of node i; an out-of-range index reads as NO_DATA, never as a depth. */
  values(i: number): NodeValues {
    return {
      dMin: this.dMin[i] ?? -Infinity,
      sigmaD: this.sigmaD[i] ?? 0,
      sigmaP: this.sigmaP[i] ?? 0,
      flags: this.flags[i] ?? NO_DATA.flags,
      cellRef: this.cellRef[i] ?? -1
    };
  }

  /** Whether node i's children are stored (its values are then bounds, not exact). */
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
