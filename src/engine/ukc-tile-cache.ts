import { rectGap, tileRect } from "../foundation/geo";
import { chartReach, chartSigma } from "../spatial/chart-position";
import type { NodeStore } from "../spatial/node-store";
import { mercatorBuffer } from "../spatial/pyramid";
import type { Adjusted } from "../spatial/tile-walk";
import { adjustmentsIn } from "../spatial/tile-walk";
import type { ThresholdRange } from "./ukc-reach";
import type { TileGeometry } from "./ukc-tile-geometry";
import { geometryBytes, tileGeometry } from "./ukc-tile-geometry";
import type { UkcTileInput } from "./ukc-tiles";

/** Default byte budget of a UkcTileCache's geometries: about 120 z14 tiles. */
export const TILE_CACHE_BYTES = 24 * 2 ** 20;

/** Default byte budget of its drawn tiles: some hundreds of them, at 1-8 kB each and their gzip. */
export const DRAWN_CACHE_BYTES = 4 * 2 ** 20;

/** Bytes an entry costs besides its columns: its objects, typed-array headers and Map slot. */
const ENTRY_BYTES = 3072;

/** Bytes a drawn tile costs besides its body and gzip: its objects and Map slot. */
const DRAWN_ENTRY_BYTES = 512;

/** What a tile was encoded to, and what it was drawn from. */
export interface DrawnTile {
  body: Uint8Array;
  /** The input it was drawn at, and the thresholds over which it is drawn the same. */
  input: UkcTileInput;
  range: ThresholdRange;
  /** `body` gzipped, once a reply has compressed it. */
  gzip?: Uint8Array;
}

interface Entry<T> {
  value: T;
  /** The living-chart cells the value was drawn from. */
  adjusted: Adjusted[];
  /** `store.adjustments.revision` they were last found unchanged at. */
  revision: number;
  bytes: number;
}

/** Entries by key, least recently used dropped first beyond `maxBytes`. */
class Lru<T> {
  bytes = 0;
  readonly entries = new Map<string, Entry<T>>();

  constructor(readonly maxBytes: number) {}

  /** The entry, removed: `put` it back to keep it. */
  take(key: string): Entry<T> | undefined {
    const e = this.entries.get(key);
    if (e) {
      this.entries.delete(key);
      this.bytes -= e.bytes;
    }
    return e;
  }

  put(key: string, e: Entry<T>): void {
    this.take(key);
    if (e.bytes > this.maxBytes) {
      return;
    }
    this.entries.set(key, e);
    this.bytes += e.bytes;
    for (const [k, old] of this.entries) {
      if (this.bytes <= this.maxBytes) {
        break;
      }
      this.entries.delete(k);
      this.bytes -= old.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/**
 * Tile geometries by (z, x, y), and the tiles drawn from them as encoded
 * bytes, each least recently used dropped first beyond its byte budget.
 * Both hold for one store and the living-chart cells in their tile: another
 * store (a handover or a WFS rebuild) empties the cache, a block read or
 * dropped near a tile drops it, and a write to the store's adjustments has
 * each entry compare the cells in its tile before it is used again
 * (invariant 5).
 *
 * A drawn tile is also the tile for any threshold in its range with the
 * other inputs the same (`ukcTileWithRange`), so a water level that moves a
 * centimetre leaves it be; a different σ, risk level or fallback flag, or a
 * threshold outside the range, draws it again.
 */
export class UkcTileCache {
  private store: WeakRef<NodeStore> | undefined;
  private count = -1;
  private loads = 0;
  private readonly geometries: Lru<TileGeometry>;
  private readonly drawn: Lru<DrawnTile>;

  constructor(maxBytes = TILE_CACHE_BYTES, maxDrawnBytes = DRAWN_CACHE_BYTES) {
    this.geometries = new Lru(maxBytes);
    this.drawn = new Lru(maxDrawnBytes);
  }

  /** Bytes of geometry held. */
  get bytes(): number {
    return this.geometries.bytes;
  }

  get maxBytes(): number {
    return this.geometries.maxBytes;
  }

  /** Geometries held. */
  get size(): number {
    return this.geometries.entries.size;
  }

  /** Bytes of drawn tiles held. */
  get drawnBytes(): number {
    return this.drawn.bytes;
  }

  get drawnSize(): number {
    return this.drawn.entries.size;
  }

  geometry(store: NodeStore, z: number, x: number, y: number): TileGeometry {
    this.sync(store);
    const key = `${z}/${x}/${y}`;
    const revision = store.adjustments.revision;
    const hit = this.geometries.take(key);
    if (hit) {
      if (hit.revision === revision || sameCells(hit.adjusted, adjustmentsIn(store, z, x, y))) {
        hit.revision = revision;
        this.geometries.put(key, hit);
        return hit.value;
      }
    }
    const adjusted = adjustmentsIn(store, z, x, y);
    const before = store.loadRevision;
    const geometry = tileGeometry(store, z, x, y);
    if (store.loadRevision !== before) {
      // The walk read small blocks on the spot: this tile saw them loaded, while tiles cached
      // before it over the same blocks saw their stand-ins.
      this.dropOver(store, store.blocksChangedSince(before));
      this.loads = store.loadRevision;
    }
    this.geometries.put(key, {
      value: geometry,
      adjusted,
      revision,
      bytes: geometryBytes(geometry) + ENTRY_BYTES + adjusted.length * 64
    });
    return geometry;
  }

  /**
   * The tile (z, x, y) as last encoded, when it was drawn from this store as
   * it is now and `input` draws the same: its σ, risk levels and fallback flag
   * are the same and its threshold lies in the range.
   */
  drawnTile(
    store: NodeStore,
    z: number,
    x: number,
    y: number,
    input: UkcTileInput
  ): DrawnTile | undefined {
    this.sync(store);
    const key = `${z}/${x}/${y}`;
    const hit = this.drawn.take(key);
    if (!hit) {
      return undefined;
    }
    const revision = store.adjustments.revision;
    if (
      !sameDrawing(hit.value.input, input) ||
      !(input.threshold >= hit.value.range.lo && input.threshold <= hit.value.range.hi) ||
      !(hit.revision === revision || sameCells(hit.adjusted, adjustmentsIn(store, z, x, y)))
    ) {
      return undefined;
    }
    hit.revision = revision;
    this.drawn.put(key, hit);
    return hit.value;
  }

  /**
   * Keeps `body`, the tile just drawn at `input` (after the `geometry` call it
   * was drawn from, so that nothing has changed in between) the same over `range`.
   */
  keepDrawn(
    store: NodeStore,
    z: number,
    x: number,
    y: number,
    input: UkcTileInput,
    range: ThresholdRange,
    body: Uint8Array
  ): DrawnTile {
    this.sync(store);
    const adjusted = adjustmentsIn(store, z, x, y);
    // Copied through: a caller that edits its thresholds in place must not edit what was drawn at.
    const value: DrawnTile = {
      body,
      input: { ...input, thresholds: { ...input.thresholds } },
      range: { ...range }
    };
    this.drawn.put(`${z}/${x}/${y}`, {
      value,
      adjusted,
      revision: store.adjustments.revision,
      // The gzip a reply adds is about as large as the body.
      bytes: 2 * body.length + DRAWN_ENTRY_BYTES + adjusted.length * 64
    });
    return value;
  }

  /** Empties the cache for another store, and drops what a block read or dropped since may have changed. */
  private sync(store: NodeStore): void {
    if (this.store?.deref() !== store || this.count !== store.count) {
      this.geometries.clear();
      this.drawn.clear();
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
  }

  private dropOver(store: NodeStore, blocks: readonly { z: number; x: number; y: number }[]): void {
    if (blocks.length === 0) {
      return;
    }
    // A tile's sources are cells up to the store's widest chart reach outside
    // it, scaled at the tile's own latitude as reachersOf scales it.
    const ground = chartReach(chartSigma(store).max);
    const near = blocks.map((b) => tileRect(b.z, b.x, b.y));
    for (const lru of [this.geometries, this.drawn]) {
      for (const key of [...lru.entries.keys()]) {
        const [z, x, y] = key.split("/").map(Number) as [number, number, number];
        const tile = tileRect(z, x, y);
        const reach = mercatorBuffer(tile, ground);
        if (near.some((rect) => rectGap(tile, rect) <= reach)) {
          lru.take(key);
        }
      }
    }
  }
}

/** Whether two inputs differ at most in the threshold. */
function sameDrawing(a: UkcTileInput, b: UkcTileInput): boolean {
  return (
    a.sigmaExtra === b.sigmaExtra &&
    a.degraded === b.degraded &&
    a.thresholds.alert === b.thresholds.alert &&
    a.thresholds.warn === b.thresholds.warn
  );
}

function sameCells(a: readonly Adjusted[], b: readonly Adjusted[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.x === b[i]?.x && c.y === b[i]?.y && c.values === b[i]?.values)
  );
}
