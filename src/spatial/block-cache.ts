import type { Rect } from "../foundation/geo";
import { tileKey, tileRange } from "../foundation/geo";
import type { BlockReader } from "./block-reader";
import type { BlockSource, NodeColumns, NodeValues, StandIn } from "./node-store";
import { NO_DATA, NodeStore } from "./node-store";
import type { BlockEntry, Summary } from "./pyramid-blocks";
import { BYTES_PER_NODE, columnsOn, inflate, inflateSync } from "./pyramid-blocks";

/**
 * The blocks of a pyramid file (`pyramid-blocks.ts`), read when a query
 * first reaches them and dropped, least recently used first, once the loaded
 * ones exceed a memory budget. A block compressed small enough is read on the
 * spot, so the query that reaches it waits a few milliseconds and answers from
 * it; a larger one is read off the event loop, and until it arrives the
 * queries reaching it read the stand-ins of its nodes (safety invariant 3).
 * Blocks are dropped only after the current turn of the event loop, so a
 * query never sees a block go mid-walk.
 */

export interface CacheOptions {
  /** Inflated bytes of loaded blocks above which the least recently used ones not kept are dropped. */
  budgetBytes: number;
  /** A block compressed to at most this many bytes is read on the spot when a query reaches it. */
  syncBytes: number;
}

/**
 * 32 MB holds about 27 of the densest z12 blocks of the Nauvo replicas (1.2 MB
 * each inflated), a 25 km square. One such block reads in about 1 ms on x86
 * (4 ms on a Raspberry Pi 4); 256 kB compressed is about 3 MB inflated.
 */
export const DEFAULT_CACHE: CacheOptions = { budgetBytes: 32 * 2 ** 20, syncBytes: 256 * 2 ** 10 };

/** Read errors that may pass: too many open files, a file busy on Windows, an interrupted read. */
const TRANSIENT = new Set([
  "EMFILE",
  "ENFILE",
  "EBUSY",
  "EAGAIN",
  "EINTR",
  "EIO",
  "EPERM",
  "EACCES"
]);

/** How long a block the system could not read waits before it is tried again, ms. */
export const RETRY_MS = 5000;

export interface CacheLayout {
  leafZoom: number;
  /** Nodes at this zoom and coarser are the store's own; finer ones are in blocks. */
  cutZoom: number;
  blockZoom: number;
  /** The first node index blocks hand out: the store's own nodes come before. */
  firstIndex: number;
}

interface Loaded {
  key: number;
  /** Node j of the block is node `base + j` of the store. */
  base: number;
  n: number;
  store: NodeStore;
  cols: NodeColumns;
  used: number;
}

export interface CacheParts {
  layout: CacheLayout;
  entries: BlockEntry[];
  /** The store's own nodes, the columns it was made from. */
  resident: NodeColumns;
  summary: Summary;
  reader: BlockReader;
  opts: CacheOptions;
}

const caches = new WeakMap<NodeStore, BlockCache>();

/** Gives `store`'s nodes finer than the cut zoom to a cache of the file's blocks. */
export function attachBlocks(store: NodeStore, parts: CacheParts, total: number): void {
  const cache = new BlockCache(parts);
  store.attach(cache, total);
  caches.set(store, cache);
}

/** The block cache behind a store read block by block, if it is one. */
export const cacheOf = (store: NodeStore): BlockCache | undefined => caches.get(store);

export class BlockCache implements BlockSource {
  readonly cutZoom: number;
  readonly blockZoom: number;
  loads = 0;
  revision = 0;
  /** The revision at which each block was last loaded or dropped. */
  private readonly changed = new Map<number, number>();
  /** Inflated bytes of the loaded blocks. */
  bytes = 0;
  private readonly leafZoom: number;
  /** Tiles per side at the block zoom. */
  private readonly side: number;
  private readonly table = new Map<number, BlockEntry>();
  private readonly loaded = new Map<number, Loaded>();
  /** The loaded blocks in increasing `base`, for finding a node's block. */
  private readonly byBase: Loaded[] = [];
  private readonly pending = new Map<number, Promise<void>>();
  /** Blocks that failed to read, with why; they read as stand-ins from then on. */
  readonly failed = new Map<number, string>();
  /** Blocks the system could not read just now, with when to try again (ms since epoch). */
  private readonly retryAt = new Map<number, number>();
  private kept = new Set<number>();
  private nextBase: number;
  private clock = 0;
  private last: Loaded | undefined;
  private trimming: NodeJS.Immediate | undefined;
  private readonly summary: Summary;
  private readonly resident: NodeColumns;
  private readonly reader: BlockReader;
  private readonly opts: CacheOptions;

  constructor(parts: CacheParts) {
    const { layout } = parts;
    this.cutZoom = layout.cutZoom;
    this.blockZoom = layout.blockZoom;
    this.side = 2 ** layout.blockZoom;
    this.leafZoom = layout.leafZoom;
    this.nextBase = layout.firstIndex;
    this.summary = parts.summary;
    this.resident = parts.resident;
    this.reader = parts.reader;
    this.opts = parts.opts;
    for (const e of parts.entries) {
      this.table.set(e.key, e);
    }
  }

  changedSince(revision: number): number[] {
    const out: number[] = [];
    for (const [key, at] of this.changed) {
      if (at > revision) {
        out.push(key);
      }
    }
    return out;
  }

  /** Blocks in the file. */
  get size(): number {
    return this.table.size;
  }

  /** Blocks loaded now. */
  get count(): number {
    return this.loaded.size;
  }

  /**
   * Whether block `key` is in the file but not loaded: a query reaching it reads stand-ins,
   * until it loads, or for good once it is refused (`failed`).
   */
  unloaded(key: number): boolean {
    return this.table.has(key) && !this.loaded.has(key);
  }

  /** The block tile holding tile (z, x, y), z ≥ the block zoom; x and y are below 2^26. */
  private keyOf(z: number, x: number, y: number): number {
    const d = z - this.blockZoom;
    return (x >>> d) * this.side + (y >>> d);
  }

  private block(key: number): Loaded | undefined {
    const last = this.last;
    if (last !== undefined && last.key === key) {
      last.used = ++this.clock;
      return last;
    }
    const b = this.loaded.get(key) ?? this.demand(key);
    if (b) {
      b.used = ++this.clock;
      this.last = b;
    }
    return b;
  }

  /** The loaded block holding node index i. */
  private at(i: number): Loaded | undefined {
    const last = this.last;
    if (last !== undefined && i >= last.base && i < last.base + last.n) {
      return last;
    }
    const list = this.byBase;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const b = list[mid] as Loaded;
      if (i < b.base) {
        hi = mid - 1;
      } else if (i >= b.base + b.n) {
        lo = mid + 1;
      } else {
        return b;
      }
    }
    return undefined;
  }

  find(z: number, x: number, y: number): number {
    const b = this.block(this.keyOf(z, x, y));
    if (!b) {
      return -1;
    }
    const j = b.store.find(z, x, y);
    return j < 0 ? -1 : b.base + j;
  }

  values(i: number): NodeValues {
    const b = this.at(i);
    return b ? b.store.values(i - b.base) : { ...NO_DATA };
  }

  isSplit(i: number): boolean {
    const b = this.at(i);
    return b !== undefined && b.store.isSplit(i - b.base);
  }

  surveySigma(i: number): number {
    const b = this.at(i);
    return b ? b.store.surveySigma(i - b.base) : 0;
  }

  topoSigma(i: number): number {
    const b = this.at(i);
    return b ? b.store.topoSigma(i - b.base) : 0;
  }

  bathyDMin(i: number): number {
    const b = this.at(i);
    return b ? b.store.bathyDMinOf(i - b.base) : Infinity;
  }

  topoDMin(i: number): number {
    const b = this.at(i);
    return b ? b.store.topoDMinOf(i - b.base) : Infinity;
  }

  standIn(i: number, x: number, y: number): StandIn | undefined {
    if (this.block(this.keyOf(this.cutZoom, x, y))) {
      return undefined;
    }
    return {
      covered: this.summary.covered[i] as number,
      sigmaDMin: this.summary.sigmaDMin[i] as number
    };
  }

  /** Every tile at zoom z, in tile-key order; reads every block. */
  *entries(z: number): Generator<[number, number, number]> {
    const out: [number, number, number][] = [];
    for (const e of this.table.values()) {
      const b = this.loaded.get(e.key) ?? this.readNow(e);
      for (const [x, y, j] of b.store.entries(z)) {
        out.push([x, y, b.base + j]);
      }
    }
    out.sort((a, b) => tileKey(z, a[0], a[1]) - tileKey(z, b[0], b[1]));
    yield* out;
  }

  /** A block a query reached: read now when small, else asked for off the event loop. */
  private demand(key: number): Loaded | undefined {
    const e = this.table.get(key);
    if (e === undefined || this.waiting(key)) {
      return undefined;
    }
    if (e.bytes > this.opts.syncBytes) {
      void this.load(key);
      return undefined;
    }
    try {
      return this.readNow(e);
    } catch (err) {
      this.fail(key, err);
      return undefined;
    }
  }

  private readNow(e: BlockEntry): Loaded {
    const body = inflateSync(this.reader.readSync(e.offset, e.bytes), BYTES_PER_NODE * e.nodes);
    return this.insert(e, body);
  }

  /**
   * A block whose bytes are bad, or whose file was replaced, is refused for
   * good; one the system could not read just now is tried again after
   * RETRY_MS, so a passing EMFILE or EBUSY leaves no lasting gap.
   */
  private fail(key: number, err: unknown): void {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && TRANSIENT.has(code)) {
      this.retryAt.set(key, Date.now() + RETRY_MS);
    } else {
      this.failed.set(key, (err as Error).message);
    }
  }

  private waiting(key: number): boolean {
    return this.failed.has(key) || (this.retryAt.get(key) ?? 0) > Date.now();
  }

  private insert(e: BlockEntry, body: Buffer): Loaded {
    const cols = columnsOn(body, e.nodes);
    const store = NodeStore.fromColumns(this.cutZoom + 1, this.leafZoom, cols);
    const b: Loaded = {
      key: e.key,
      base: this.nextBase,
      n: e.nodes,
      store,
      cols,
      used: ++this.clock
    };
    this.nextBase += e.nodes;
    this.retryAt.delete(e.key);
    this.loaded.set(e.key, b);
    this.byBase.push(b);
    this.bytes += BYTES_PER_NODE * e.nodes;
    this.loads++;
    this.changed.set(e.key, ++this.revision);
    if (this.bytes > this.opts.budgetBytes && this.trimming === undefined) {
      this.trimming = setImmediate(() => {
        this.trimming = undefined;
        this.trim();
      });
      this.trimming.unref();
    }
    return b;
  }

  /** Reads block `key` off the event loop unless it is loaded, failed or on its way. */
  load(key: number): Promise<void> {
    const e = this.table.get(key);
    if (e === undefined || this.loaded.has(key) || this.waiting(key)) {
      return Promise.resolve();
    }
    let p = this.pending.get(key);
    if (p === undefined) {
      p = this.reader
        .read(e.offset, e.bytes)
        .then((buf) => this.inflate(e, buf))
        .then(
          (body) => {
            if (!this.loaded.has(key)) {
              this.insert(e, body);
            }
          },
          (err: unknown) => this.fail(key, err)
        )
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  /**
   * A small block is inflated on the event loop, in about as long as a read
   * on the spot takes: inflates on the thread pool leave freed memory in each
   * thread's malloc arena, which held 35 MB of RSS after one pass over the
   * Nauvo replicas' 448 blocks.
   */
  private inflate(e: BlockEntry, buf: Buffer): Promise<Buffer> | Buffer {
    const bytes = BYTES_PER_NODE * e.nodes;
    return e.bytes > this.opts.syncBytes ? inflate(buf, bytes) : inflateSync(buf, bytes);
  }

  /** The blocks in the file whose tiles meet `rect` (Mercator). */
  blocksMeeting(rect: Rect): number[] {
    const r = tileRange(this.blockZoom, rect);
    const out: number[] = [];
    for (let x = r.minX; x <= r.maxX; x++) {
      for (let y = r.minY; y <= r.maxY; y++) {
        const key = tileKey(this.blockZoom, x, y);
        if (this.table.has(key)) {
          out.push(key);
        }
      }
    }
    return out;
  }

  /**
   * Keeps the blocks meeting `rects` loaded, reading the missing ones off the
   * event loop; the blocks kept before and not now may be dropped again.
   */
  keep(rects: readonly Rect[]): Promise<void> {
    this.kept = new Set(rects.flatMap((r) => this.blocksMeeting(r)));
    return Promise.all([...this.kept].map((k) => this.load(k))).then(() => undefined);
  }

  /** Drops the least recently used blocks not kept until the rest fit the budget. */
  trim(): void {
    const spare = [...this.loaded.values()]
      .filter((b) => !this.kept.has(b.key))
      .sort((a, b) => a.used - b.used);
    for (const b of spare) {
      if (this.bytes <= this.opts.budgetBytes) {
        return;
      }
      this.loaded.delete(b.key);
      this.byBase.splice(this.byBase.indexOf(b), 1);
      this.bytes -= BYTES_PER_NODE * b.n;
      this.changed.set(b.key, ++this.revision);
      if (this.last === b) {
        this.last = undefined;
      }
    }
  }

  /** Reads block `key` now unless it is loaded, whatever its size; throws if it fails. */
  loadNow(key: number): void {
    const e = this.table.get(key);
    if (e !== undefined && !this.loaded.has(key)) {
      this.readNow(e);
    }
  }

  /** Reads every block now, whatever the budget; throws on the first that fails. */
  loadAll(): void {
    for (const key of this.table.keys()) {
      this.loadNow(key);
    }
  }

  /** The resident columns and every block's, in key order; reads every block now. */
  columns(): { resident: NodeColumns; blocks: { key: number; cols: NodeColumns }[] } {
    const blocks = [...this.table.values()].map((e) => ({
      key: e.key,
      cols: (this.loaded.get(e.key) ?? this.readNow(e)).cols
    }));
    return { resident: this.resident, blocks };
  }

  /** Every block's tile key, in increasing order. */
  keys(): number[] {
    return [...this.table.keys()];
  }

  /** Reads and inflates every block without keeping it, so damage anywhere is found now. */
  verifySync(): void {
    for (const e of this.table.values()) {
      inflateSync(this.reader.readSync(e.offset, e.bytes), BYTES_PER_NODE * e.nodes);
    }
  }

  /** `verifySync` with the reads off the event loop, one block at a time. */
  async verify(): Promise<void> {
    for (const e of this.table.values()) {
      await this.inflate(e, await this.reader.read(e.offset, e.bytes));
    }
  }
}
