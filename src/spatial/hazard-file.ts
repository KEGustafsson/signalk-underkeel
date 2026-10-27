import os from "os";
import zlib from "zlib";
import { HazardIndex } from "./hazards";

/**
 * `hazards.bin`: a JSON header line, padded with spaces to a multiple of 8
 * bytes, then the index body (`hazards.ts`), little-endian. The header
 * gives the body's length and CRC-32, so a short, long or changed file is
 * refused and the index rebuilt, never read as one with fewer hazards.
 * Version 1 replaced `hazards.json`; an index saved with that is rebuilt.
 */

const MAGIC = "underkeel-hazards";
export const HAZARDS_VERSION = 1;

interface HazardsHeader {
  magic: string;
  version: number;
  /** Body bytes after the header line. */
  bytes: number;
  crc: number;
}

/** CRC-32 (IEEE), as zlib computes it; Node before 22.2 has no `zlib.crc32`. */
let table: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
  if (typeof zlib.crc32 === "function") {
    return zlib.crc32(data);
  }
  table ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of data) {
    c = (table[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function requireLittleEndian(): void {
  if (os.endianness() !== "LE") {
    throw new Error("hazard files are little-endian; this host is big-endian");
  }
}

/** The file bytes of `index`, in a buffer of their own. */
export function serializeHazards(index: HazardIndex): Uint8Array {
  requireLittleEndian();
  const { body } = index;
  const header: HazardsHeader = {
    magic: MAGIC,
    version: HAZARDS_VERSION,
    bytes: body.length,
    crc: crc32(body)
  };
  const json = JSON.stringify(header);
  const line = Buffer.from(`${json.padEnd(Math.ceil((json.length + 1) / 8) * 8 - 1)}\n`, "utf8");
  const out = new Uint8Array(line.length + body.length);
  out.set(line);
  out.set(body, line.length);
  return out;
}

function headerOf(buf: Uint8Array): { header: HazardsHeader; length: number } {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) {
    throw new Error("hazards file has no header");
  }
  const header = JSON.parse(
    Buffer.from(buf.buffer, buf.byteOffset, nl).toString("utf8")
  ) as HazardsHeader;
  return { header, length: nl + 1 };
}

function parseHeader(buf: Uint8Array): { header: HazardsHeader; length: number } {
  requireLittleEndian();
  const parsed = headerOf(buf);
  const { magic, version } = parsed.header;
  if (magic !== MAGIC || version !== HAZARDS_VERSION) {
    throw new Error(`unsupported hazards file ${magic} v${version}`);
  }
  return parsed;
}

/**
 * Whether a hazards file's first bytes are the header of another version. A
 * damaged header is not: reading the file names what is wrong with it.
 */
export function isOtherHazardsVersion(head: Uint8Array): boolean {
  try {
    const { magic, version } = headerOf(head).header;
    return magic === MAGIC && version !== HAZARDS_VERSION;
  } catch {
    return false;
  }
}

/** The index in file bytes `buf`; refuses a foreign header, a wrong length or a CRC mismatch. */
export function readHazards(buf: Uint8Array): HazardIndex {
  const { header, length } = parseHeader(buf);
  const body = buf.subarray(length);
  if (body.length !== header.bytes) {
    throw new Error(
      body.length < header.bytes ? "hazards file is truncated" : "hazards file is corrupt"
    );
  }
  if (crc32(body) !== header.crc) {
    throw new Error("hazards file is corrupt (CRC mismatch)");
  }
  return new HazardIndex(body);
}
