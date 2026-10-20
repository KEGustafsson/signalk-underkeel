import { constants, gunzip, gunzipSync } from "zlib";
import type { NodeColumns } from "./node-store";
import { FLAGS } from "./node-store";

/**
 * How pyramid.bin is cut for loading on demand (plan §4.3): every node at
 * `residentZoom` or coarser is read at start, and the finer ones are stored
 * in one block per `blockZoom` tile, read when a query first reaches it. On
 * 64 replicas of the Nauvo pair, zooms 10–15 are 0.24 % of 13.5 M nodes
 * (1.2 MB); a z10 root holds up to 505 k nodes (19 MB inflated), a z12 tile
 * a sixteenth of that, so the blocks within a look-ahead's reach fit a Pi's
 * memory where whole roots would not.
 */
export interface BlockLayout {
  residentZoom: number;
  blockZoom: number;
}

export const DEFAULT_LAYOUT: BlockLayout = { residentZoom: 15, blockZoom: 12 };

/** The layout as it applies to a pyramid of zooms minZoom..leafZoom. */
export function layoutFor(minZoom: number, leafZoom: number, l: BlockLayout): BlockLayout {
  const residentZoom = Math.max(minZoom, Math.min(l.residentZoom, leafZoom));
  return { residentZoom, blockZoom: Math.max(minZoom, Math.min(l.blockZoom, residentZoom)) };
}

/** Per resident node, for a split node at the resident zoom: its `StandIn`. */
export interface Summary {
  covered: Float64Array;
  sigmaDMin: Float32Array;
}

export interface BlockSplit {
  /** Nodes [0, resident) of the columns are resident; they come first in zoom order. */
  resident: number;
  summary: Summary;
  /** Block tile keys in increasing order, and each block's run in `order`. */
  keys: number[];
  starts: number[];
  /** Indices of the finer nodes, block by block, each block in column order. */
  order: Int32Array;
}

const POW = Array.from({ length: 31 }, (_, z) => 2 ** z);

/** The tile at zoom `to` holding tile (z, x, y), as tileKey(to, ...); x and y are below 2^26. */
const ancestorKey = (z: number, x: number, y: number, to: number): number =>
  (x >>> (z - to)) * (POW[to] as number) + (y >>> (z - to));

/** Index of `key` in the sorted run keys[from..to), or -1. */
function bisect(keys: Float64Array, from: number, to: number, key: number): number {
  let lo = from;
  let hi = to - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const k = keys[mid] as number;
    if (k === key) {
      return mid;
    }
    if (k < key) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

/** Nodes [0, resident) are at the resident zoom or coarser, [cut, resident) at it. */
function residentRun(z: Uint8Array, rz: number): { resident: number; cut: number } {
  let resident = 0;
  while (resident < z.length && (z[resident] as number) <= rz) {
    resident++;
  }
  let cut = resident;
  while (cut > 0 && z[cut - 1] === rz) {
    cut--;
  }
  return { resident, cut };
}

/** x and y of node j's tile. */
function tileOf(cols: NodeColumns, j: number): { z: number; x: number; y: number } {
  const z = cols.z[j] as number;
  const key = cols.key[j] as number;
  const x = Math.floor(key / (POW[z] as number));
  return { z, x, y: key - x * (POW[z] as number) };
}

/**
 * The stand-in of each split node at the resident zoom: the shallowest
 * depth and narrowest σD of the leaves under it that have a charted depth.
 */
function summarize(cols: NodeColumns, rz: number, cut: number, resident: number): Summary {
  const summary: Summary = {
    covered: new Float64Array(resident).fill(Infinity),
    sigmaDMin: new Float32Array(resident).fill(Infinity)
  };
  // Neighbouring nodes mostly share a resident ancestor.
  let last = NaN;
  let r = -1;
  for (let j = resident; j < cols.z.length; j++) {
    if (cols.split[j] === 0 && ((cols.flags[j] as number) & FLAGS.NO_DEPTH) === 0) {
      const { z, x, y } = tileOf(cols, j);
      const ck = ancestorKey(z, x, y, rz);
      if (ck !== last) {
        last = ck;
        r = bisect(cols.key, cut, resident, ck);
      }
      if (r >= 0) {
        summary.covered[r] = Math.min(summary.covered[r] as number, cols.dMin[j] as number);
        summary.sigmaDMin[r] = Math.min(summary.sigmaDMin[r] as number, cols.sigmaD[j] as number);
      }
    }
  }
  return summary;
}

/** The finer nodes grouped by block in key order, each block in column order. */
function group(cols: NodeColumns, bz: number, resident: number) {
  const n = cols.z.length;
  const blockOf = new Int32Array(n - resident);
  const index = new Map<number, number>();
  const counts: number[] = [];
  let last = NaN;
  let b = -1;
  for (let j = resident; j < n; j++) {
    const { z, x, y } = tileOf(cols, j);
    const bk = ancestorKey(z, x, y, bz);
    if (bk !== last) {
      last = bk;
      b = index.get(bk) ?? counts.push(0) - 1;
      index.set(bk, b);
    }
    counts[b] = (counts[b] as number) + 1;
    blockOf[j - resident] = b;
  }
  const keys = [...index.keys()].sort((p, q) => p - q);
  const starts: number[] = [];
  const at = new Int32Array(counts.length);
  let start = 0;
  for (const k of keys) {
    const i = index.get(k) as number;
    starts.push(start);
    at[i] = start;
    start += counts[i] as number;
  }
  const order = new Int32Array(n - resident);
  for (let j = resident; j < n; j++) {
    const i = blockOf[j - resident] as number;
    order[at[i] as number] = j;
    at[i] = (at[i] as number) + 1;
  }
  return { keys, starts, order };
}

/**
 * Splits columns in zoom and tile-key order into the resident nodes with
 * their stand-ins and each block's nodes.
 */
export function splitBlocks(cols: NodeColumns, layout: BlockLayout): BlockSplit {
  const { resident, cut } = residentRun(cols.z, layout.residentZoom);
  return {
    resident,
    summary: summarize(cols, layout.residentZoom, cut, resident),
    ...group(cols, layout.blockZoom, resident)
  };
}

/** Bytes per node of a block body: the columns of `columnsOn`. */
export const BYTES_PER_NODE = 8 + 8 + 4 * 4 + 2 + 1 + 1;

/** Bytes per resident node: a block node's columns and its stand-in's. */
const BYTES_PER_RESIDENT = BYTES_PER_NODE + 8 + 4;

/** One block's place in the file. */
export interface BlockEntry {
  /** tileKey of its tile at the block zoom. */
  key: number;
  nodes: number;
  /** Byte offset of its gzip member in the file, and its length. */
  offset: number;
  bytes: number;
}

/** Inflated bytes of the table and resident nodes. */
export const headBytes = (blocks: number, resident: number): number =>
  24 * blocks + BYTES_PER_RESIDENT * resident;

/** Hands out views on `buffer` from `offset`, `count` elements each. */
function viewer(buffer: ArrayBufferLike, offset: number, count: number) {
  let at = offset;
  const next = (size: number): number => {
    const from = at;
    at += size * count;
    return from;
  };
  return {
    f64: () => new Float64Array(buffer, next(8), count),
    f32: () => new Float32Array(buffer, next(4), count),
    i32: () => new Int32Array(buffer, next(4), count),
    u16: () => new Uint16Array(buffer, next(2), count),
    u8: () => new Uint8Array(buffer, next(1), count)
  };
}

const aligned = (body: Uint8Array): Uint8Array =>
  body.byteOffset % 8 === 0 ? body : new Uint8Array(body);

/**
 * A block body's columns as views on it, so loading copies nothing; every
 * column starts aligned when the body does.
 */
export function columnsOn(body: Uint8Array, count: number): NodeColumns {
  const b = aligned(body);
  const v = viewer(b.buffer, b.byteOffset, count);
  return {
    dMin: v.f64(),
    key: v.f64(),
    sigmaD: v.f32(),
    sigmaP: v.f32(),
    surveySigmaP: v.f32(),
    cellRef: v.i32(),
    flags: v.u16(),
    z: v.u8(),
    split: v.u8()
  };
}

/** The table, resident columns and stand-ins as views on the inflated head. */
export function headOn(
  body: Uint8Array,
  blocks: number,
  resident: number
): { table: Float64Array; cols: NodeColumns; summary: Summary } {
  const b = aligned(body);
  const table = new Float64Array(b.buffer, b.byteOffset, 3 * blocks);
  const v = viewer(b.buffer, b.byteOffset + table.byteLength, resident);
  const [dMin, key, covered] = [v.f64(), v.f64(), v.f64()];
  const [sigmaD, sigmaP, surveySigmaP, sigmaDMin] = [v.f32(), v.f32(), v.f32(), v.f32()];
  const cols = { dMin, key, sigmaD, sigmaP, surveySigmaP, cellRef: v.i32(), flags: v.u16() };
  return {
    table,
    cols: { ...cols, z: v.u8(), split: v.u8() },
    summary: { covered, sigmaDMin }
  };
}

/** One output chunk of the expected size: 16 kB chunks are joined at the end, holding the body twice. */
const inflateOptions = (bytes: number) => ({
  chunkSize: Math.max(constants.Z_MIN_CHUNK, bytes + 64)
});

/** A short member ends the stream early; a changed byte fails the CRC or the data. */
function inflateError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  return new Error(
    code === "Z_BUF_ERROR" ? "pyramid file is truncated" : `pyramid file is corrupt (${code})`,
    { cause: err }
  );
}

function sized(out: Buffer, bytes: number): Buffer {
  if (out.length !== bytes) {
    throw new Error(`pyramid file is corrupt (${out.length} bytes where ${bytes} were expected)`);
  }
  return out;
}

/** Inflates one gzip member that must hold exactly `bytes`. */
export function inflateSync(member: Buffer, bytes: number): Buffer {
  let out: Buffer;
  try {
    out = gunzipSync(member, inflateOptions(bytes));
  } catch (err) {
    throw inflateError(err);
  }
  return sized(out, bytes);
}

/** `inflateSync` on the libuv thread pool, off the event loop. */
export function inflate(member: Buffer, bytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) =>
    gunzip(member, inflateOptions(bytes), (err, out) =>
      err ? reject(inflateError(err)) : resolve(out)
    )
  ).then((out) => sized(out, bytes));
}
