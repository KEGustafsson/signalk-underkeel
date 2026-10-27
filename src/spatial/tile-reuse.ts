import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { writeFileDurable } from "../foundation/durable-file";
import type { Rect } from "../foundation/geo";
import { expandRect, rectContainsRect, rectsOverlap, tileKey, tileRect } from "../foundation/geo";
import type { Bbox } from "../ingest/wfs-fetch";
import { boxRect } from "./build-box";
import type { CellReach, Item } from "./build-items";
import { buildArea } from "./build-items";
import type { NodeColumns } from "./node-store";
import { NodeStore } from "./node-store";
import type { Evaluated, RootRange, TakeTile } from "./pyramid-build";
import { cellsReaching } from "./pyramid-regions";
import { bodyColumns, PYRAMID_VERSION } from "./store";

/**
 * Reuse of a saved box index's tiles when the box moves (plan §4.2). The
 * nodes of a tile and of every tile below it are a function of the items the
 * tile is evaluated from and of the box tests `evaluate` makes on each of
 * those tiles. Those tests come out the same way on every tile under a tile
 * wholly inside the box, and on every tile under one in the build area wholly
 * outside the box (`boxState`). A tile in the same such state in the saved
 * box and the new one, evaluated from the same items, has the saved nodes,
 * and they are copied.
 *
 * A box build records, for each tile from minZoom to DIGEST_MAX_ZOOM that it
 * evaluates in such a state, a digest of its state and its items in order:
 * each item's cell by content (`sourceIdentity`), its place among the cell's
 * features and whether an ancestor tile lay wholly inside it. A root in the
 * same state in both boxes that the same cells reach in the same order gets
 * the same items, and is copied without reading the cells.
 */

export const TILES_FILE = "tiles.json";

/** Tiles are digested down to this zoom: 0.6 km across at 53° N. */
export const DIGEST_MAX_ZOOM = 15;

/**
 * A tile counts as inside or outside a rectangle only this many Mercator
 * metres clear of its edges, so every tile below it is too, whatever the
 * rounding of their edges.
 */
const EDGE_MARGIN = 1;

/** Tile (z, key) and the digest of the items it was evaluated from. */
export type TileDigest = [z: number, key: number, digest: string];

/** Copied nodes' cell reference to a cell the new catalogue lacks: such nodes are not copied. */
const UNMAPPED = -2;

/** Every tile under `rect` lies inside the box. */
const INSIDE = 1;
/** Every tile under `rect` lies in the build area, with no ground inside the box. */
const RING = 2;

/**
 * INSIDE or RING when every tile under `rect` takes the box tests of a build
 * within `box` (Mercator) the same way; 0 otherwise.
 */
export function boxState(box: Rect, rect: Rect): number {
  if (rectContainsRect(expandRect(box, -EDGE_MARGIN), rect)) {
    return INSIDE;
  }
  const area = expandRect(buildArea(box), -EDGE_MARGIN);
  return rectContainsRect(area, rect) && !rectsOverlap(expandRect(box, EDGE_MARGIN), rect)
    ? RING
    : 0;
}

const pluginVersion = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** A saved index from another plugin version or pyramid format may differ from a new build. */
const BUILD_STAMP = `${pluginVersion} pyramid ${PYRAMID_VERSION} digest 1`;

const tileOf = (z: number, key: number): { x: number; y: number } => {
  const n = 2 ** z;
  return { x: Math.floor(key / n), y: key % n };
};

/**
 * The nodes of root (x, y) at the store's minZoom, copied out zoom by zoom
 * in tile-key order: the columns a build of that root alone gives.
 */
export function rootColumns(store: NodeStore, x: number, y: number): NodeColumns {
  return subtreeColumns(store, store.minZoom, x, y);
}

/**
 * The nodes of tile (z0, x, y) and of every tile below it, zoom by zoom in tile-key order. At
 * zoom z the tile holds s = 2^(z − z0) tile columns, each a run of s keys.
 */
export function subtreeColumns(store: NodeStore, z0: number, x: number, y: number): NodeColumns {
  const found: number[] = [];
  for (let z = z0; z <= store.leafZoom; z++) {
    const s = 2 ** (z - z0);
    const n = 2 ** z;
    for (let tx = x * s; tx < (x + 1) * s; tx++) {
      for (const [key, i] of store.keyRange(z, tx * n + y * s, tx * n + (y + 1) * s)) {
        found.push(z, key, i);
      }
    }
  }
  const { cols } = bodyColumns(found.length / 3);
  for (let at = 0; at < cols.z.length; at++) {
    const i = found[3 * at + 2] as number;
    cols.z[at] = found[3 * at] as number;
    cols.key[at] = found[3 * at + 1] as number;
    cols.dMin[at] = store.dMin[i] as number;
    cols.sigmaD[at] = store.sigmaD[i] as number;
    cols.sigmaP[at] = store.sigmaP[i] as number;
    cols.surveySigmaP[at] = store.surveySigmaP[i] as number;
    cols.topoSigmaP[at] = store.topoSigmaP[i] as number;
    cols.bathyDMin[at] = store.bathyDMin[i] as number;
    cols.topoDMin[at] = store.topoDMin[i] as number;
    cols.flags[at] = store.flags[i] as number;
    cols.cellRef[at] = store.cellRef[i] as number;
    cols.split[at] = store.split[i] as number;
  }
  return cols;
}

/** Whether tile (z, key) lies in tile (z0, x0, y0), itself included. */
function under(z: number, key: number, z0: number, x0: number, y0: number): boolean {
  if (z < z0) {
    return false;
  }
  const { x, y } = tileOf(z, key);
  const s = 2 ** (z - z0);
  return Math.floor(x / s) === x0 && Math.floor(y / s) === y0;
}

const digestKey = (z: number, key: number): string => `${z}/${key}`;

/** What a region job may copy from the saved index for one root. */
export interface RegionSaved {
  /** The saved root's nodes, cell references in the new catalogue. */
  cols: NodeColumns;
  /** The saved digests of the root's tiles in the same `boxState` in both boxes. */
  digests: TileDigest[];
}

/** One root's prepared features: for each `Item.ord`, its cell's identity and its place there. */
export interface ItemCells {
  ids: (string | undefined)[];
  cellAt: Int32Array;
  indexAt: Int32Array;
}

/** `ItemCells` of features read cell by cell, `ids[c]` the identity of cell c. */
export function itemCells(ids: (string | undefined)[], counts: readonly number[]): ItemCells {
  const total = counts.reduce((a, b) => a + b, 0);
  const cellAt = new Int32Array(total);
  const indexAt = new Int32Array(total);
  let at = 0;
  counts.forEach((n, c) => {
    for (let i = 0; i < n; i++, at++) {
      cellAt[at] = c;
      indexAt[at] = i;
    }
  });
  return { ids, cellAt, indexAt };
}

/**
 * The digests of one root's tiles in a `boxState`, and the take that copies a tile whose
 * digest the saved index holds.
 */
export class RegionTiles {
  readonly recorded: TileDigest[] = [];
  /** Nodes copied from the saved index. */
  copied = 0;
  private readonly maxZoom: number;
  private readonly saved?: { store: NodeStore; digests: Map<string, string>; list: TileDigest[] };

  constructor(
    private readonly box: Rect,
    zooms: { minZoom: number; leafZoom: number },
    private readonly cells: ItemCells,
    saved?: RegionSaved
  ) {
    this.maxZoom = Math.min(DIGEST_MAX_ZOOM, zooms.leafZoom);
    if (saved) {
      this.saved = {
        store: NodeStore.fromColumns(zooms.minZoom, zooms.leafZoom, saved.cols),
        digests: new Map(saved.digests.map(([z, key, d]) => [digestKey(z, key), d])),
        list: saved.digests
      };
    }
  }

  /** Undefined when an item's cell has no identity. */
  private digest(
    state: number,
    z: number,
    x: number,
    y: number,
    items: Item[]
  ): string | undefined {
    const words = new Int32Array(4 + 3 * items.length);
    words[0] = state;
    words[1] = z;
    words[2] = x;
    words[3] = y;
    const order = new Map<number, number>();
    const ids: string[] = [];
    for (let j = 0; j < items.length; j++) {
      const item = items[j] as Item;
      const c = this.cells.cellAt[item.ord] as number;
      let o = order.get(c);
      if (o === undefined) {
        const id = this.cells.ids[c];
        if (id === undefined) {
          return undefined;
        }
        o = ids.length;
        order.set(c, o);
        ids.push(id);
      }
      words[4 + 3 * j] = o;
      words[5 + 3 * j] = this.cells.indexAt[item.ord] as number;
      words[6 + 3 * j] = item.full ? 1 : 0;
    }
    return createHash("sha256")
      .update(new Uint8Array(words.buffer))
      .update(JSON.stringify(ids))
      .digest("base64");
  }

  readonly take: TakeTile = (store, z, x, y, rect, items) => {
    const state = z > this.maxZoom ? 0 : boxState(this.box, rect);
    if (state === 0) {
      return undefined;
    }
    const digest = this.digest(state, z, x, y, items);
    if (digest === undefined) {
      return undefined;
    }
    const key = tileKey(z, x, y);
    this.recorded.push([z, key, digest]);
    const s = this.saved;
    if (!s || s.digests.get(digestKey(z, key)) !== digest) {
      return undefined;
    }
    const cols = subtreeColumns(s.store, z, x, y);
    if (cols.z[0] !== z || cols.key[0] !== key || cols.cellRef.some((r) => r === UNMAPPED)) {
      return undefined;
    }
    let top: Evaluated | undefined;
    for (let i = 0; i < cols.z.length; i++) {
      const zi = cols.z[i] as number;
      const t = tileOf(zi, cols.key[i] as number);
      const e: Evaluated = {
        v: {
          dMin: cols.dMin[i] as number,
          sigmaD: cols.sigmaD[i] as number,
          sigmaP: cols.sigmaP[i] as number,
          flags: cols.flags[i] as number,
          cellRef: cols.cellRef[i] as number
        },
        position: {
          surveySigmaP: cols.surveySigmaP[i] as number,
          topoSigmaP: cols.topoSigmaP[i] as number,
          bathyDMin: cols.bathyDMin[i] as number,
          topoDMin: cols.topoDMin[i] as number
        }
      };
      store.add(zi, t.x, t.y, e.v, cols.split[i] === 1, e.position);
      top ??= e;
    }
    this.copied += cols.z.length;
    for (const d of s.list) {
      if (d[0] > z && under(d[0], d[1], z, x, y)) {
        this.recorded.push(d);
      }
    }
    return top;
  };
}

/** The saved index's tiles file, read only when it belongs to the saved pyramid. */
export interface SavedTiles {
  /** The box it was built in, Mercator. */
  box: Rect;
  /** Each cell's identity by catalogue index. */
  ids: string[];
  digests: TileDigest[];
}

const sha256 = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Writes the tiles file of the index staged in `staging`, after its pyramid. */
export function writeTiles(
  staging: string,
  t: { bbox: Bbox; minZoom: number; leafZoom: number; ids: string[]; digests: TileDigest[] }
): void {
  const digests = [...t.digests].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  writeFileDurable(
    path.join(staging, TILES_FILE),
    JSON.stringify({
      version: 1,
      stamp: BUILD_STAMP,
      minZoom: t.minZoom,
      leafZoom: t.leafZoom,
      bbox: t.bbox,
      pyramid: sha256(path.join(staging, "pyramid.bin")),
      cells: t.ids,
      tiles: digests
    })
  );
}

const isDigest = (d: unknown): d is TileDigest =>
  Array.isArray(d) &&
  d.length === 3 &&
  Number.isInteger(d[0]) &&
  Number.isInteger(d[1]) &&
  typeof d[2] === "string";

/**
 * The tiles file in `dir` when this plugin version wrote it at these zooms, for `cells` cells
 * and the pyramid file now in `dir`; otherwise undefined and nothing is copied.
 */
export function readTiles(
  dir: string,
  z: { minZoom: number; leafZoom: number },
  cells: number
): SavedTiles | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, TILES_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    const { bbox, cells: ids, tiles } = json;
    if (
      json.version !== 1 ||
      json.stamp !== BUILD_STAMP ||
      json.minZoom !== z.minZoom ||
      json.leafZoom !== z.leafZoom ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every(Number.isFinite) ||
      !Array.isArray(ids) ||
      ids.length !== cells ||
      !ids.every((id) => typeof id === "string") ||
      !Array.isArray(tiles) ||
      !tiles.every(isDigest) ||
      json.pyramid !== sha256(path.join(dir, "pyramid.bin"))
    ) {
      return undefined;
    }
    return { box: boxRect(bbox as Bbox), ids: ids as string[], digests: tiles };
  } catch {
    return undefined;
  }
}

/** The saved index as a box build reuses it. */
export interface SavedBox {
  pyramid: NodeStore;
  reaches: readonly CellReach[];
  tiles: SavedTiles;
}

/** What a box build takes from the saved index, by position in its roots. */
export interface BoxReuse {
  /** Roots copied whole, with the digests of their tiles. */
  roots: Map<number, RegionSaved>;
  /** What each other root's region job may copy. */
  regions: Map<number, RegionSaved>;
}

/** `cols` with each cell reference moved to the new catalogue by `map`. */
function remapped(cols: NodeColumns, map: Int32Array): NodeColumns {
  return { ...cols, cellRef: cols.cellRef.map((r) => (r < 0 ? r : (map[r] ?? UNMAPPED))) };
}

/**
 * The saved nodes a box build within `now.box` may copy into `roots`, the
 * new cells' identities and reaches by catalogue index. A root in the same
 * `boxState` in both boxes is copied whole when the same cells by identity,
 * in the same order, reach it in both builds: its items are then the same.
 * Otherwise its region job gets the saved digests of its tiles in the same
 * state in both boxes.
 */
export function boxReuse(
  saved: SavedBox,
  now: { box: Rect; ids: readonly string[]; reaches: readonly CellReach[] },
  roots: readonly RootRange[]
): BoxReuse {
  const { minZoom } = saved.pyramid;
  const at = new Map(now.ids.map((id, i) => [id, i]));
  const map = Int32Array.from(saved.tiles.ids, (id) => at.get(id) ?? UNMAPPED);
  const inBoth = (r: Rect) => {
    const state = boxState(now.box, r);
    return state !== 0 && state === boxState(saved.tiles.box, r);
  };
  const out: BoxReuse = { roots: new Map(), regions: new Map() };
  roots.forEach(({ minX: x, minY: y }, k) => {
    const digests = saved.tiles.digests.filter(([z, key]) => {
      const t = tileOf(z, key);
      return under(z, key, minZoom, x, y) && inBoth(tileRect(z, t.x, t.y));
    });
    const whole = inBoth(tileRect(minZoom, x, y)) && sameCells(saved, now, { x, y });
    if (!whole && digests.length === 0) {
      return;
    }
    const cols = remapped(rootColumns(saved.pyramid, x, y), map);
    if (cols.z.length === 0) {
      return;
    }
    if (whole && !cols.cellRef.includes(UNMAPPED)) {
      out.roots.set(k, { cols, digests });
    } else if (digests.length > 0) {
      out.regions.set(k, { cols, digests });
    }
  });
  return out;
}

/** Whether the same cells by identity, in the same order, reach root (x, y) in both builds. */
function sameCells(
  saved: SavedBox,
  now: { ids: readonly string[]; reaches: readonly CellReach[] },
  { x, y }: { x: number; y: number }
): boolean {
  const root = { minX: x, minY: y, maxX: x, maxY: y };
  const { minZoom } = saved.pyramid;
  const was = cellsReaching(root, minZoom, saved.reaches).map((j) => saved.tiles.ids[j]);
  const is = cellsReaching(root, minZoom, now.reaches).map((i) => now.ids[i]);
  return was.length === is.length && was.every((id, i) => id !== undefined && id === is[i]);
}
