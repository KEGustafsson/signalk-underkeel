import fs from "fs";
import type { Bbox } from "./wfs-fetch";
import { encFiles } from "./enc-wasm";

/**
 * An S-57 cell's extent from its coordinates, read straight from the ISO 8211
 * records of the `.000` and its updates without GDAL: every SG2D and SG3D
 * field, scaled by the DSPM's COMF. A vessel-centred build picks its cells by
 * this, so 698 NOAA cells are sorted in about a second instead of read in
 * minutes. A file it cannot follow gives no extent, and the cell is then
 * taken wherever the vessel is.
 */

/** [west, south, east, north] in degrees, or undefined when the files could not be read. */
export function encBounds(file: string): Bbox | undefined {
  const box = { w: Infinity, s: Infinity, e: -Infinity, n: -Infinity };
  let comf: number | undefined;
  try {
    for (const f of encFiles(file)) {
      const read = scanRecords(fs.readFileSync(f), (tag, data) => {
        if (tag === "DSPM" && data.length >= 20) {
          comf = data.readInt32LE(16);
        } else if (tag === "SG2D" || tag === "SG3D") {
          const step = tag === "SG2D" ? 8 : 12;
          // The field ends with its terminator; whole coordinate tuples come before it.
          for (let at = 0; at + step <= data.length; at += step) {
            const y = data.readInt32LE(at);
            const x = data.readInt32LE(at + 4);
            box.w = Math.min(box.w, x);
            box.e = Math.max(box.e, x);
            box.s = Math.min(box.s, y);
            box.n = Math.max(box.n, y);
          }
        }
      });
      if (!read) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  if (!(comf !== undefined && comf > 0) || !(box.w <= box.e && box.s <= box.n)) {
    return undefined;
  }
  return [box.w / comf, box.s / comf, box.e / comf, box.n / comf];
}

/** Calls `field` for each field of each data record; false when the file is not plain ISO 8211. */
function scanRecords(buf: Buffer, field: (tag: string, data: Buffer) => void): boolean {
  const num = (at: number, len: number): number => {
    const n = Number(buf.toString("latin1", at, at + len));
    return Number.isInteger(n) ? n : NaN;
  };
  let at = 0;
  let first = true;
  while (at < buf.length) {
    const length = num(at, 5);
    if (!(length >= 24) || at + length > buf.length) {
      return false;
    }
    // A record whose leader says to reuse the previous directory is not followed here.
    if (!first && buf.toString("latin1", at + 6, at + 7) !== "D") {
      return false;
    }
    if (!first) {
      const base = at + num(at + 12, 5);
      const [lenSize, posSize, tagSize] = [num(at + 20, 1), num(at + 21, 1), num(at + 23, 1)];
      if (![base, lenSize, posSize, tagSize].every((n) => n > 0)) {
        return false;
      }
      const entry = tagSize + lenSize + posSize;
      for (let e = at + 24; buf[e] !== 0x1e && e + entry <= base; e += entry) {
        const tag = buf.toString("latin1", e, e + tagSize);
        const len = num(e + tagSize, lenSize);
        const pos = num(e + tagSize + lenSize, posSize);
        if (!(len >= 0 && pos >= 0) || base + pos + len > at + length) {
          return false;
        }
        field(tag, buf.subarray(base + pos, base + pos + len));
      }
    }
    first = false;
    at += length;
  }
  return true;
}

/** Whether `a` and `b`, both [west, south, east, north], overlap. */
export const bboxesMeet = (a: Bbox, b: Bbox): boolean =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
