import os from "os";
import { gzipSync } from "zlib";
import { tileKey } from "../foundation/geo";
import type { CacheOptions } from "./block-cache";
import { attachBlocks, cacheOf, DEFAULT_CACHE } from "./block-cache";
import type { BlockReader } from "./block-reader";
import { bufferReader, fileReader, fileReaderAsync } from "./block-reader";
import type { NodeColumns } from "./node-store";
import { NodeStore } from "./node-store";
import type { BlockEntry, BlockLayout, BlockSplit } from "./pyramid-blocks";
import {
  BYTES_PER_NODE,
  columnsOn,
  DEFAULT_LAYOUT,
  headBytes,
  headOn,
  inflate,
  inflateSync,
  joinBlocks,
  layoutFor,
  splitBlocks
} from "./pyramid-blocks";

/**
 * On-disk pyramid format: a JSON header line, then a gzip member holding
 * the block table and the resident nodes (zoom `residentZoom` and coarser,
 * with their stand-ins), then one gzip member per block of finer nodes
 * (`pyramid-blocks.ts`), so a store can read only the blocks a query reaches
 * (`block-cache.ts`). Each member's CRC refuses a changed byte when it is
 * inflated, and the table's sizes refuse a short or long file. Columns are
 * little-endian, one per node field, nodes in order of zoom and then tile
 * key, so they are read as they are; big-endian hosts are refused rather
 * than reading swapped values.
 *
 * The version also counts changes to how nodes are built from the chart
 * (version 2: swept σ, coverage seams, skin-of-earth classes; version 3:
 * the assessed survey σP column for chart reach; version 4: compressed
 * columns; version 5: a tile key column instead of x and y, nodes in key
 * order; version 6: resident nodes and blocks; version 7: the topographic
 * σ and survey-placed depth columns for graded chart position, points in
 * assessed water no longer burned), so an index built under
 * older rules is rebuilt rather than reused.
 */

const MAGIC = "underkeel-pyramid";
export const PYRAMID_VERSION = 7;

export interface PyramidHeader extends BlockLayout {
  magic: string;
  version: number;
  minZoom: number;
  leafZoom: number;
  count: number;
  /** Resident nodes. */
  resident: number;
  blocks: number;
  /** Compressed bytes of the table and resident nodes. */
  head: number;
}

type Columns = NodeColumns;

function columnsOf(count: number): Columns {
  return {
    z: new Uint8Array(count),
    key: new Float64Array(count),
    dMin: new Float64Array(count),
    sigmaD: new Float32Array(count),
    sigmaP: new Float32Array(count),
    surveySigmaP: new Float32Array(count),
    topoSigmaP: new Float32Array(count),
    bathyDMin: new Float32Array(count),
    flags: new Uint16Array(count),
    cellRef: new Int32Array(count),
    split: new Uint8Array(count)
  };
}

const ORDER: (keyof Columns)[] = [
  "dMin",
  "key",
  "sigmaD",
  "sigmaP",
  "surveySigmaP",
  "topoSigmaP",
  "bathyDMin",
  "cellRef",
  "flags",
  "z",
  "split"
];

function requireLittleEndian(): void {
  if (os.endianness() !== "LE") {
    throw new Error("pyramid files are little-endian; this host is big-endian");
  }
}

/** Every stored node's columns, zoom by zoom and in tile-key order within a zoom. */
export function pyramidColumns(store: NodeStore): NodeColumns {
  const cols = columnsOf(store.count);
  let n = 0;
  for (let z = store.minZoom; z <= store.leafZoom; z++) {
    for (const [x, y, i] of store.entries(z)) {
      const v = store.values(i);
      cols.z[n] = z;
      cols.key[n] = tileKey(z, x, y);
      cols.dMin[n] = v.dMin;
      cols.sigmaD[n] = v.sigmaD;
      cols.sigmaP[n] = v.sigmaP;
      cols.surveySigmaP[n] = store.surveySigma(i);
      cols.topoSigmaP[n] = store.topoSigma(i);
      cols.bathyDMin[n] = store.bathyDMinOf(i);
      cols.flags[n] = v.flags;
      cols.cellRef[n] = v.cellRef;
      cols.split[n] = store.isSplit(i) ? 1 : 0;
      n++;
    }
  }
  // A tile stored twice is entered once, so fewer than `count` may be filled.
  return n === store.count ? cols : sliceColumns(cols, 0, n);
}

function sliceColumns(cols: Columns, from: number, to: number): Columns {
  const out = {} as Record<keyof Columns, Columns[keyof Columns]>;
  for (const k of ORDER) {
    out[k] = cols[k].slice(from, to);
  }
  return out as Columns;
}

/** The columns of `store` in zoom and tile-key order, without a copy when it was built so. */
function orderedColumns(store: NodeStore): NodeColumns {
  const saved = bodies.get(store);
  if (saved && saved.dMin === store.dMin && store.dMin.length === store.count) {
    return columnsOn(saved.body, store.count);
  }
  return pyramidColumns(store);
}

/** One block's nodes gathered from `cols` into a body in file layout, run by run of columns. */
function blockBody(cols: NodeColumns, split: BlockSplit, b: number): Uint8Array {
  const from = split.starts[b] as number;
  const to = split.starts[b + 1] ?? split.order.length;
  const { order } = split;
  const body = new Uint8Array(BYTES_PER_NODE * (to - from));
  const out = columnsOn(body, to - from);
  for (let t = from; t < to;) {
    const start = order[t] as number;
    let end = t + 1;
    while (end < to && order[end] === start + (end - t)) {
      end++;
    }
    for (const k of ORDER) {
      (out[k] as Float64Array).set(
        (cols[k] as Float64Array).subarray(start, start + end - t),
        t - from
      );
    }
    t = end;
  }
  return body;
}

function headBody(cols: NodeColumns, split: BlockSplit, blocks: Buffer[]): Uint8Array {
  const n = split.resident;
  const body = new Uint8Array(headBytes(blocks.length, n));
  const head = headOn(body, blocks.length, n);
  split.keys.forEach((key, b) => {
    const to = split.starts[b + 1] ?? split.order.length;
    head.table.set([key, to - (split.starts[b] as number), (blocks[b] as Buffer).length], 3 * b);
  });
  for (const k of ORDER) {
    head.cols[k].set(cols[k].subarray(0, n));
  }
  head.summary.covered.set(split.summary.covered);
  head.summary.sigmaDMin.set(split.summary.sigmaDMin);
  return body;
}

const gzip = (body: Uint8Array): Buffer => gzipSync(body, { level: 1 });

/** The store as file bytes, in the current format. */
export function serializePyramid(store: NodeStore, layout: BlockLayout = DEFAULT_LAYOUT): Buffer {
  requireLittleEndian();
  const cols = orderedColumns(store);
  const l = layoutFor(store.minZoom, store.leafZoom, layout);
  const split = splitBlocks(cols, l);
  const blocks = split.keys.map((_, b) => gzip(blockBody(cols, split, b)));
  const head = gzip(headBody(cols, split, blocks));
  const header: PyramidHeader = {
    magic: MAGIC,
    version: PYRAMID_VERSION,
    minZoom: store.minZoom,
    leafZoom: store.leafZoom,
    ...l,
    count: cols.dMin.length,
    resident: split.resident,
    blocks: blocks.length,
    head: head.length
  };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), head, ...blocks]);
}

/**
 * Stores whose columns are views on one buffer laid out as a block body, in
 * file order: their serialization reads that buffer without a copy.
 */
const bodies = new WeakMap<NodeStore, { body: Uint8Array; dMin: Float64Array }>();

/** Columns for `count` nodes, as views on one new buffer laid out as a block body. */
export function bodyColumns(count: number): { body: Uint8Array; cols: NodeColumns } {
  const body = new Uint8Array(BYTES_PER_NODE * count);
  return { body, cols: columnsOn(body, count) };
}

/** The store over `cols`, views on `body`, remembered for a copy-free save when in file order. */
export function storeOnBody(
  minZoom: number,
  leafZoom: number,
  body: Uint8Array,
  cols: NodeColumns
): NodeStore {
  const store = NodeStore.fromColumns(minZoom, leafZoom, cols);
  const { z, key } = cols;
  let ordered = true;
  for (let i = 1; i < key.length && ordered; i++) {
    ordered = z[i] !== z[i - 1] || (key[i] as number) > (key[i - 1] as number);
  }
  if (ordered) {
    bodies.set(store, { body, dMin: cols.dMin });
  }
  return store;
}

function parseHeader(buf: Buffer): { header: PyramidHeader; length: number } {
  requireLittleEndian();
  const nl = buf.indexOf(0x0a);
  if (nl < 0) {
    throw new Error("pyramid file has no header");
  }
  const header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as PyramidHeader;
  if (header.magic !== MAGIC || header.version !== PYRAMID_VERSION) {
    throw new Error(`unsupported pyramid file ${header.magic} v${header.version}`);
  }
  return { header, length: nl + 1 };
}

/** Whether a pyramid file's header is this format and version. */
export function isCurrentPyramid(head: Buffer): boolean {
  try {
    return parseHeader(head).header.version === PYRAMID_VERSION;
  } catch {
    return false;
  }
}

/**
 * The store over an inflated head: the resident nodes, and when the file
 * has blocks a cache reading them through `reader`. The table must account
 * for every byte of the file and every node of the header.
 */
function assemble(
  header: PyramidHeader,
  length: number,
  inflated: Buffer,
  size: number,
  reader: BlockReader,
  opts: CacheOptions
): NodeStore {
  if (inflated.length !== headBytes(header.blocks, header.resident)) {
    throw new Error("pyramid file is corrupt (its head has the wrong size)");
  }
  const { table, cols, summary } = headOn(inflated, header.blocks, header.resident);
  const entries: BlockEntry[] = [];
  let offset = length + header.head;
  let nodes = header.resident;
  for (let b = 0; b < header.blocks; b++) {
    const [key, n, bytes] = [table[3 * b], table[3 * b + 1], table[3 * b + 2]] as number[];
    entries.push({ key: key as number, nodes: n as number, offset, bytes: bytes as number });
    offset += bytes as number;
    nodes += n as number;
  }
  if (offset !== size) {
    throw new Error(offset > size ? "pyramid file is truncated" : "pyramid file is corrupt");
  }
  if (nodes !== header.count) {
    throw new Error("pyramid file is corrupt (its blocks hold the wrong number of nodes)");
  }
  const store = NodeStore.fromColumns(header.minZoom, header.leafZoom, cols);
  if (entries.length > 0) {
    const layout = { ...header, cutZoom: header.residentZoom, firstIndex: header.resident };
    attachBlocks(store, { layout, entries, resident: cols, summary, reader, opts }, header.count);
  }
  return store;
}

/** A store over the file bytes in `buf`, its blocks read from them as `opts` says. */
export function pyramidFromBuffer(buf: Buffer, opts: CacheOptions = DEFAULT_CACHE): NodeStore {
  const { header, length } = parseHeader(buf);
  const reader = bufferReader(buf);
  const head = inflateSync(
    reader.readSync(length, header.head),
    headBytes(header.blocks, header.resident)
  );
  return assemble(header, length, head, buf.length, reader, opts);
}

/** Reads a whole current-version file into a store; refuses a foreign header or any damage. */
export function deserializePyramid(buf: Buffer): NodeStore {
  const store = pyramidFromBuffer(buf, WHOLE);
  cacheOf(store)?.loadAll();
  return store;
}

/**
 * The store with every node in its own columns, in file order, for code
 * that reads a store's levels directly; a store held whole is returned as is.
 */
export function wholePyramid(store: NodeStore): NodeStore {
  const cache = cacheOf(store);
  if (!cache) {
    return store;
  }
  const { resident, blocks } = cache.columns();
  const { body, cols } = joinBlocks(resident, blocks, cache.blockZoom);
  return storeOnBody(store.minZoom, store.leafZoom, body, cols);
}

/** A store held whole: every block loaded and none evicted. */
const WHOLE: CacheOptions = { budgetBytes: Infinity, syncBytes: Infinity };

/**
 * The store of a pyramid file whose head is read now and whose blocks are
 * read as queries reach them (`block-cache.ts`).
 */
export function openPyramid(file: string, opts: CacheOptions = DEFAULT_CACHE): NodeStore {
  const reader = fileReader(file);
  const { header, length } = parseHeader(reader.readSync(0, Math.min(reader.size, HEADER_MAX)));
  const head = inflateSync(
    reader.readSync(length, header.head),
    headBytes(header.blocks, header.resident)
  );
  return assemble(header, length, head, reader.size, reader, opts);
}

/** `openPyramid` with the reads and the head's inflate off the event loop. */
export async function openPyramidAsync(
  file: string,
  opts: CacheOptions = DEFAULT_CACHE
): Promise<NodeStore> {
  const reader = await fileReaderAsync(file);
  const { header, length } = parseHeader(await reader.read(0, Math.min(reader.size, HEADER_MAX)));
  const head = await inflate(
    await reader.read(length, header.head),
    headBytes(header.blocks, header.resident)
  );
  return assemble(header, length, head, reader.size, reader, opts);
}

/** The header line is far shorter than this. */
const HEADER_MAX = 4096;
