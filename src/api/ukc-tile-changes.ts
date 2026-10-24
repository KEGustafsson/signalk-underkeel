import { randomBytes } from "crypto";
import type { ThresholdRange } from "../engine/ukc-tiles";
import type { Rect } from "../foundation/geo";
import { rectGap, tileRect } from "../foundation/geo";
import { chartReach, chartSigma } from "../spatial/chart-position";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import { mercatorBuffer } from "../spatial/pyramid";

/**
 * Which served UKC tiles a plotter should fetch again (`GET
 * /tiles/ukc/changes`). A tile's classes hold over a range of the threshold
 * depth (ukcTileWithRange); a tile is listed once the threshold leaves the
 * range of a copy served, an own sounding changes a cell in it, or a block
 * within its chart reach loads or is dropped (a tile drawn while it was out
 * read its stand-ins). Any other input (σ, risk levels, a fallback water
 * level, the index) changing lists every tile. Clients hold a cursor: the
 * server's epoch and a revision.
 */

/** What a tile is drawn from besides its address and the threshold. */
export interface TileInputs {
  store: NodeStore;
  /** σ, risk levels and the fallback flag, as one string. */
  key: string;
  threshold: number;
}

export interface TileChanges {
  epoch: string;
  rev: number;
  /** Fetch every tile again. */
  all: boolean;
  /** [z, x, y] of each tile to fetch again. */
  tiles: [number, number, number][];
}

interface Served {
  z: number;
  x: number;
  y: number;
  /** Thresholds at which every copy served since the tile was last listed is right. */
  range: ThresholdRange;
}

export class UkcTileChanges {
  readonly epoch = randomBytes(6).toString("hex");
  private rev = 0;
  /** A cursor older than this has lost changes and refreshes everything. */
  private floor = 0;
  private store: NodeStore | undefined;
  private key: string | undefined;
  private adjustments = new Map<number, NodeValues>();
  /** `store.adjustments.revision` when `adjustments` was copied. */
  private revision = 0;
  /** `store.loadRevision` at the last observe. */
  private loads = 0;
  private readonly served = new Map<string, Served>();
  /** Listed tiles and the revision they were listed at, oldest first. */
  private readonly changed = new Map<string, number>();

  constructor(
    private readonly maxServed = 4096,
    private readonly maxChanged = 4096
  ) {}

  /** Brings the list up to the current inputs: before a tile is drawn and before each answer. */
  observe(now: TileInputs): void {
    if (now.store !== this.store || now.key !== this.key) {
      if (this.store !== undefined) {
        this.rev++;
        this.floor = this.rev;
      }
      this.store = now.store;
      this.key = now.key;
      this.adjustments = new Map(now.store.adjustments);
      this.revision = now.store.adjustments.revision;
      this.loads = now.store.loadRevision;
      this.served.clear();
      this.changed.clear();
      return;
    }
    const moved = this.movedAdjustments(now.store);
    const near = this.changedBlocks(now.store);
    const out = [...this.served].filter(
      ([, s]) =>
        !(now.threshold >= s.range.lo && now.threshold <= s.range.hi) ||
        moved.some((a) => holds(s, now.store.adjustZoom, a)) ||
        near(s)
    );
    if (out.length > 0) {
      this.rev++;
      out.forEach(([k]) => this.list(k));
    }
  }

  /** Records a tile drawn after observe(inputs) the same over `range`. */
  serve(z: number, x: number, y: number, range: ThresholdRange): void {
    const k = `${z}/${x}/${y}`;
    const had = this.served.get(k);
    // Copies drawn at thresholds whose ranges do not meet differ: the empty range lists the tile.
    const both = had
      ? { lo: Math.max(had.range.lo, range.lo), hi: Math.min(had.range.hi, range.hi) }
      : range;
    this.served.delete(k);
    this.served.set(k, { z, x, y, range: both });
    if (this.served.size > this.maxServed) {
      const [oldest] = this.served.keys();
      this.rev++;
      this.list(oldest as string);
    }
  }

  /** The tiles listed after `cursor`; without one, a cursor to start from. */
  since(cursor: { epoch: string; rev: number } | undefined): TileChanges {
    const head = { epoch: this.epoch, rev: this.rev };
    if (!cursor) {
      return { ...head, all: false, tiles: [] };
    }
    if (cursor.epoch !== this.epoch || !(cursor.rev >= this.floor && cursor.rev <= this.rev)) {
      return { ...head, all: true, tiles: [] };
    }
    const tiles: [number, number, number][] = [];
    for (const [k, at] of this.changed) {
      if (at > cursor.rev) {
        const [z, x, y] = k.split("/").map(Number) as [number, number, number];
        tiles.push([z, x, y]);
      }
    }
    return { ...head, all: false, tiles };
  }

  private list(k: string): void {
    this.served.delete(k);
    this.changed.delete(k);
    this.changed.set(k, this.rev);
    if (this.changed.size > this.maxChanged) {
      const [oldest, at] = this.changed.entries().next().value as [string, number];
      this.changed.delete(oldest);
      this.floor = Math.max(this.floor, at);
    }
  }

  /**
   * Whether a served tile lies within chart reach of a block loaded or dropped
   * since the last call, as UkcTileCache drops its geometry.
   */
  private changedBlocks(store: NodeStore): (s: Served) => boolean {
    if (store.loadRevision === this.loads) {
      return () => false;
    }
    const blocks: Rect[] = store.blocksChangedSince(this.loads).map((b) => tileRect(b.z, b.x, b.y));
    this.loads = store.loadRevision;
    if (blocks.length === 0) {
      return () => false;
    }
    const ground = chartReach(chartSigma(store).max);
    return (s) => {
      const tile = tileRect(s.z, s.x, s.y);
      const reach = mercatorBuffer(tile, ground);
      return blocks.some((b) => rectGap(tile, b) <= reach);
    };
  }

  /** Living-chart cells whose values changed since the last call, as tileKeys. */
  private movedAdjustments(store: NodeStore): number[] {
    if (store.adjustments.revision === this.revision) {
      return [];
    }
    this.revision = store.adjustments.revision;
    const moved: number[] = [];
    for (const [key, v] of store.adjustments) {
      if (this.adjustments.get(key) !== v) {
        moved.push(key);
      }
    }
    for (const key of this.adjustments.keys()) {
      if (!store.adjustments.has(key)) {
        moved.push(key);
      }
    }
    if (moved.length > 0) {
      this.adjustments = new Map(store.adjustments);
    }
    return moved;
  }
}

/** Whether living-chart cell `key` at zoom `az` lies in tile `s` or covers it. */
function holds(s: Served, az: number, key: number): boolean {
  const n = 2 ** az;
  const ax = Math.floor(key / n);
  const ay = key % n;
  if (s.z >= az) {
    const k = 2 ** (s.z - az);
    return Math.floor(s.x / k) === ax && Math.floor(s.y / k) === ay;
  }
  const k = 2 ** (az - s.z);
  return Math.floor(ax / k) === s.x && Math.floor(ay / k) === s.y;
}
