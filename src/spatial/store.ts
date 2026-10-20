import os from "os";
import { tileKey } from "../foundation/geo";
import { constants, gunzip, gunzipSync, gzipSync } from "zlib";
import type { NodeColumns } from "./node-store";
import { NodeStore } from "./node-store";

/**
 * On-disk pyramid format: a JSON header line, then one little-endian
 * column per node field, the columns together gzip-compressed (level 1:
 * 7.5 MB of columns write as 0.56 MB, and the CRC refuses a torn body of
 * the right length). Nodes are written in order of zoom and then tile key,
 * so loading reads the columns as they are into the store; the
 * index is built once and reloaded at every plugin start. Columns are
 * written in native byte order, so big-endian hosts are refused rather
 * than reading swapped values.
 *
 * The version also counts changes to how nodes are built from the chart
 * (version 2: swept σ, coverage seams, skin-of-earth classes; version 3:
 * the assessed survey σP column for chart reach; version 4: compressed
 * columns; version 5: a tile key column instead of x and y, nodes in key
 * order), so an index built under older rules is rebuilt rather than reused.
 */

const MAGIC = "underkeel-pyramid";
export const PYRAMID_VERSION = 5;

interface Header {
  magic: string;
  version: number;
  minZoom: number;
  leafZoom: number;
  count: number;
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
      cols.surveySigmaP[n] = store.surveySigmaP[i] as number;
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

/** The store as file bytes, in the current format. */
export function serializePyramid(store: NodeStore): Buffer {
  requireLittleEndian();
  const saved = bodies.get(store);
  if (saved && saved.dMin === store.dMin && store.dMin.length === store.count) {
    return encode(store, store.count, [saved.body]);
  }
  const cols = pyramidColumns(store);
  const n = cols.dMin.length;
  return encode(
    store,
    n,
    ORDER.map((k) => cols[k])
  );
}

function encode(store: NodeStore, count: number, parts: ArrayBufferView[]): Buffer {
  const header: Header = {
    magic: MAGIC,
    version: PYRAMID_VERSION,
    minZoom: store.minZoom,
    leafZoom: store.leafZoom,
    count
  };
  const head = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  const bytes = parts.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  const body = bytes.length === 1 ? (bytes[0] as Buffer) : Buffer.concat(bytes);
  return Buffer.concat([head, gzipSync(body, { level: 1 })]);
}

/**
 * Stores whose columns are views on one buffer laid out as the file body, in
 * file order: their serialization compresses that buffer without a copy.
 */
const bodies = new WeakMap<NodeStore, { body: Uint8Array; dMin: Float64Array }>();

/** Columns for `count` nodes, as views on one new buffer laid out as the file body. */
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

/** Whether a pyramid file's header is this format and version. */
export function isCurrentPyramid(head: Buffer): boolean {
  const nl = head.indexOf(0x0a);
  try {
    const header = JSON.parse(
      head.subarray(0, nl < 0 ? head.length : nl).toString("utf8")
    ) as Header;
    return header.magic === MAGIC && header.version === PYRAMID_VERSION;
  } catch {
    return false;
  }
}

const BYTES_PER_NODE = 8 + 8 + 4 * 4 + 2 + 1 + 1;

/**
 * The columns as views on the inflated body, in ORDER, so loading copies
 * nothing; every column starts aligned when the body does.
 */
function columnsOn(body: Uint8Array, count: number): Columns {
  const bytes = body.byteOffset % 8 === 0 ? body : new Uint8Array(body);
  let offset = bytes.byteOffset;
  const next = (size: number): number => {
    const at = offset;
    offset += size * count;
    return at;
  };
  const b = bytes.buffer;
  return {
    dMin: new Float64Array(b, next(8), count),
    key: new Float64Array(b, next(8), count),
    sigmaD: new Float32Array(b, next(4), count),
    sigmaP: new Float32Array(b, next(4), count),
    surveySigmaP: new Float32Array(b, next(4), count),
    cellRef: new Int32Array(b, next(4), count),
    flags: new Uint16Array(b, next(2), count),
    z: new Uint8Array(b, next(1), count),
    split: new Uint8Array(b, next(1), count)
  };
}

/** One output chunk of the expected size: 16 kB chunks are joined at the end, holding the body twice. */
const inflateOptions = (bytes: number) => ({
  chunkSize: Math.max(constants.Z_MIN_CHUNK, bytes + 64)
});

/** A short file ends the stream early; a changed byte fails the CRC or the data. */
function inflateError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  return new Error(
    code === "Z_BUF_ERROR" ? "pyramid file is truncated" : `pyramid file is corrupt (${code})`,
    { cause: err }
  );
}

interface Parsed {
  header: Header;
  /** The compressed columns. */
  body: Buffer;
  /** Their size inflated. */
  bytes: number;
}

function parse(buf: Buffer): Parsed {
  requireLittleEndian();
  const nl = buf.indexOf(0x0a);
  if (nl < 0) {
    throw new Error("pyramid file has no header");
  }
  const header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as Header;
  if (header.magic !== MAGIC || header.version !== PYRAMID_VERSION) {
    throw new Error(`unsupported pyramid file ${header.magic} v${header.version}`);
  }
  return { header, body: buf.subarray(nl + 1), bytes: BYTES_PER_NODE * header.count };
}

function storeOn(p: Parsed, inflated: Buffer): NodeStore {
  if (inflated.length < p.bytes) {
    throw new Error("pyramid file is truncated");
  }
  const cols = columnsOn(inflated, p.header.count);
  const body = new Uint8Array(cols.dMin.buffer, cols.dMin.byteOffset, p.bytes);
  return storeOnBody(p.header.minZoom, p.header.leafZoom, body, cols);
}

/** Reads a current-version file; refuses a foreign header or a truncated body. */
export function deserializePyramid(buf: Buffer): NodeStore {
  const p = parse(buf);
  let inflated: Buffer;
  try {
    inflated = gunzipSync(p.body, inflateOptions(p.bytes));
  } catch (err) {
    throw inflateError(err);
  }
  return storeOn(p, inflated);
}

/** `deserializePyramid` with the inflate on the libuv thread pool, off the event loop. */
export async function deserializePyramidAsync(buf: Buffer): Promise<NodeStore> {
  const p = parse(buf);
  const inflated = await new Promise<Buffer>((resolve, reject) =>
    gunzip(p.body, inflateOptions(p.bytes), (err, out) =>
      err ? reject(inflateError(err)) : resolve(out)
    )
  );
  return storeOn(p, inflated);
}
