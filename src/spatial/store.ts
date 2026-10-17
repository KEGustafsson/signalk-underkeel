import os from "os";
import { NodeStore } from "./node-store";

/**
 * On-disk pyramid format, version 1: a JSON header line, then one
 * little-endian column per node field. Loading rebuilds the tile maps in
 * memory; the index is built once and reloaded at every plugin start.
 * Columns are written in native byte order, so big-endian hosts are refused
 * rather than reading swapped values.
 */

const MAGIC = "underkeel-pyramid";
const VERSION = 1;

interface Header {
  magic: string;
  version: number;
  minZoom: number;
  leafZoom: number;
  count: number;
}

interface Columns {
  z: Uint8Array;
  x: Uint32Array;
  y: Uint32Array;
  dMin: Float64Array;
  sigmaD: Float32Array;
  sigmaP: Float32Array;
  flags: Uint16Array;
  cellRef: Int32Array;
  split: Uint8Array;
}

function columnsOf(count: number): Columns {
  return {
    z: new Uint8Array(count),
    x: new Uint32Array(count),
    y: new Uint32Array(count),
    dMin: new Float64Array(count),
    sigmaD: new Float32Array(count),
    sigmaP: new Float32Array(count),
    flags: new Uint16Array(count),
    cellRef: new Int32Array(count),
    split: new Uint8Array(count)
  };
}

const ORDER: (keyof Columns)[] = [
  "dMin",
  "x",
  "y",
  "sigmaD",
  "sigmaP",
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

/** Every stored node, zoom by zoom, in the version-1 format. */
export function serializePyramid(store: NodeStore): Buffer {
  requireLittleEndian();
  const cols = columnsOf(store.count);
  let n = 0;
  for (let z = store.minZoom; z <= store.leafZoom; z++) {
    for (const [x, y, i] of store.entries(z)) {
      const v = store.values(i);
      cols.z[n] = z;
      cols.x[n] = x;
      cols.y[n] = y;
      cols.dMin[n] = v.dMin;
      cols.sigmaD[n] = v.sigmaD;
      cols.sigmaP[n] = v.sigmaP;
      cols.flags[n] = v.flags;
      cols.cellRef[n] = v.cellRef;
      cols.split[n] = store.isSplit(i) ? 1 : 0;
      n++;
    }
  }
  const header: Header = {
    magic: MAGIC,
    version: VERSION,
    minZoom: store.minZoom,
    leafZoom: store.leafZoom,
    count: n
  };
  const head = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  // Exactly `n` entries per column, the count the header records.
  const parts = ORDER.map((k) => {
    const col = cols[k].subarray(0, n);
    return Buffer.from(col.buffer, col.byteOffset, col.byteLength);
  });
  return Buffer.concat([head, ...parts]);
}

/** Reads a version-1 file; refuses a foreign header or a truncated body. */
export function deserializePyramid(buf: Buffer): NodeStore {
  requireLittleEndian();
  const nl = buf.indexOf(0x0a);
  if (nl < 0) {
    throw new Error("pyramid file has no header");
  }
  const header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as Header;
  if (header.magic !== MAGIC || header.version !== VERSION) {
    throw new Error(`unsupported pyramid file ${header.magic} v${header.version}`);
  }
  const count = header.count;
  const cols = columnsOf(count);
  let offset = nl + 1;
  for (const k of ORDER) {
    const col = cols[k];
    const bytes = col.byteLength;
    if (offset + bytes > buf.length) {
      throw new Error("pyramid file is truncated");
    }
    // Copied byte-wise: the column's offset in `buf` need not be aligned.
    new Uint8Array(col.buffer).set(buf.subarray(offset, offset + bytes));
    offset += bytes;
  }
  const store = new NodeStore(header.minZoom, header.leafZoom);
  for (let i = 0; i < count; i++) {
    store.add(
      cols.z[i] as number,
      cols.x[i] as number,
      cols.y[i] as number,
      {
        dMin: cols.dMin[i] as number,
        sigmaD: cols.sigmaD[i] as number,
        sigmaP: cols.sigmaP[i] as number,
        flags: cols.flags[i] as number,
        cellRef: cols.cellRef[i] as number
      },
      cols.split[i] === 1
    );
  }
  return store;
}
