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
 * depth (ukcTileWithRange). Each tile is drawn at one of two water levels
 * (plan §4.5): the level inside the source's reach, or the level beyond it.
 * A tile is listed once the threshold of the level it was drawn at leaves
 * the range of a copy served, a moved forecast point carries it across the
 * reach edge, an own sounding changes a cell in it, or a block within its
 * chart reach loads or is dropped after the tile was drawn (a tile drawn
 * while the block was out read its stand-ins). Any other input changing
 * lists every tile: σ, risk levels or the fallback flag of either level,
 * the reach appearing or going, or the index. Clients hold a cursor: the
 * server's epoch and a revision.
 */

/** What a tile is drawn from besides its address and the threshold. */
export interface TileInputs {
  store: NodeStore;
  /** σ and the fallback flag of each level regime, and the risk levels, as one string. */
  key: string;
  /** For tiles inside the level source's reach, or for every tile without one. */
  threshold: number;
  /** Tiles beyond the reach of the level source, when it has one. */
  beyond?: {
    threshold: number;
    /** Identifies the reach geometry; changes when the forecast point moves. */
    reach: string;
    /** Whether tile (z, x, y) lies wholly inside the reach, and is drawn at `threshold` above. */
    within(z: number, x: number, y: number): boolean;
  };
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
  /** Whether it was drawn inside the level source's reach, or beyond it. */
  inside: boolean;
  /** `store.loadRevision` after the oldest of those copies was drawn. */
  loads: number;
}

export class UkcTileChanges {
  readonly epoch = randomBytes(6).toString("hex");
  private rev = 0;
  /** A cursor older than this has lost changes and refreshes everything. */
  private floor = 0;
  private store: NodeStore | undefined;
  private key: string | undefined;
  /** `beyond.reach` at the last observe. */
  private reach: string | undefined;
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
      // Whether `beyond` is there is part of the key, so its coming or going answers all.
      this.reach = now.beyond?.reach;
      this.adjustments = new Map(now.store.adjustments);
      this.revision = now.store.adjustments.revision;
      this.loads = now.store.loadRevision;
      this.served.clear();
      this.changed.clear();
      return;
    }
    const reached = now.beyond !== undefined && now.beyond.reach !== this.reach;
    this.reach = now.beyond?.reach;
    const moved = this.movedAdjustments(now.store);
    const near = this.changedBlocks(now.store);
    const out = [...this.served].filter(([, s]) => stale(s, now, reached, moved, near));
    if (out.length > 0) {
      this.rev++;
      out.forEach(([k]) => this.list(k));
    }
  }

  /**
   * Records a tile drawn after observe(inputs) the same over `range`, inside
   * the level source's reach or beyond it.
   */
  serve(z: number, x: number, y: number, range: ThresholdRange, inside = true): void {
    const k = `${z}/${x}/${y}`;
    let had = this.served.get(k);
    if (had && had.inside !== inside) {
      // Drawn at the other level: the copy held may differ whatever the threshold.
      this.rev++;
      this.list(k);
      had = undefined;
    }
    // Copies drawn at thresholds whose ranges do not meet differ: the empty range lists the tile.
    const both = had
      ? { lo: Math.max(had.range.lo, range.lo), hi: Math.min(had.range.hi, range.hi) }
      : range;
    // The oldest copy held is the one a block loaded since may have changed.
    const loads = had ? had.loads : (this.store?.loadRevision ?? 0);
    this.served.delete(k);
    this.served.set(k, { z, x, y, range: both, inside, loads });
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
   * since the last call and after the tile was drawn, as UkcTileCache drops
   * its geometry. A small block a tile's own drawing read on the spot loaded
   * before it was served, so that copy already has it.
   */
  private changedBlocks(store: NodeStore): (s: Served) => boolean {
    if (store.loadRevision === this.loads) {
      return () => false;
    }
    const since = this.loads;
    this.loads = store.loadRevision;
    // Only tiles served since the last call were drawn after it: a handful of revisions.
    const after = new Map<number, Rect[]>();
    const blocksAfter = (revision: number): Rect[] => {
      let blocks = after.get(revision);
      if (!blocks) {
        blocks = store.blocksChangedSince(revision).map((b) => tileRect(b.z, b.x, b.y));
        after.set(revision, blocks);
      }
      return blocks;
    };
    let ground: number | undefined;
    return (s) => {
      const blocks = blocksAfter(Math.max(since, s.loads));
      if (blocks.length === 0) {
        return false;
      }
      ground ??= chartReach(chartSigma(store).max);
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

/**
 * Whether a served tile may differ from the tile drawn now: the forecast
 * point moved it across the reach edge, the threshold of the level it was
 * drawn at left its range, an own sounding changed a cell in it, or a block
 * near it changed.
 */
function stale(
  s: Served,
  now: TileInputs,
  reached: boolean,
  moved: readonly number[],
  near: (s: Served) => boolean
): boolean {
  const beyond = now.beyond;
  if (reached && beyond && beyond.within(s.z, s.x, s.y) !== s.inside) {
    return true;
  }
  const threshold = s.inside || !beyond ? now.threshold : beyond.threshold;
  return (
    !(threshold >= s.range.lo && threshold <= s.range.hi) ||
    moved.some((a) => holds(s, now.store.adjustZoom, a)) ||
    near(s)
  );
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
