import fs from "fs";
import path from "path";
import type { ReadCell } from "../ingest/cell-reader";
import { readCellDirectory } from "../ingest/cell-reader";
import type { EncLayers } from "../ingest/enc-wasm";
import { encCell } from "../ingest/enc-wasm";

/**
 * Cells parsed from their layers, kept from one use to the next up to a budget of bytes. The
 * survey and every region reaching a cell each parsed its GeoJSON again: the 10 km Waddenzee
 * box parsed its 8 cells 24 times, the whole set its 20 cells 86 times, at 4.4 s for one
 * parse of all 20 (x86).
 */

/** Heap held per byte of layers: 535 MB for the 281 MB of the 20 Waddenzee cells' layers. */
const HEAP_PER_BYTE = 2;

/** A cell to parse: an S-57 cell from its layers, a GeoJSON directory from its files. */
export interface CellSource {
  dir: string;
  ref: number;
  layers?: EncLayers;
  /** The cell's content (`sourceIdentity`), for the digests of a box build's tiles. */
  id?: string;
}

/** The heap a parse of `c` holds, estimated from the bytes it is parsed from. */
function parsedBytes(c: CellSource): number {
  let bytes = 0;
  if (c.layers) {
    Object.values(c.layers).forEach((b) => (bytes += b.byteLength));
  } else {
    try {
      fs.readdirSync(c.dir).forEach((f) => (bytes += fs.statSync(path.join(c.dir, f)).size));
    } catch {
      // Read by the parse, which reports the failure.
    }
  }
  return bytes * HEAP_PER_BYTE;
}

export const cellKey = (c: CellSource): string => `${c.ref}\n${c.dir}`;

/**
 * Parsed cells by catalogue index and source. A cell's features hold its catalogue index, so a
 * cell parsed for another index is parsed again.
 */
export class ParsedCells {
  private readonly held = new Map<string, { cell: ReadCell; bytes: number }>();
  private bytes = 0;

  constructor(readonly budget: number) {}

  cell(c: CellSource): ReadCell {
    const key = cellKey(c);
    const kept = this.held.get(key);
    if (kept) {
      return kept.cell;
    }
    const cell = c.layers ? encCell(c.dir, c.layers, c.ref) : readCellDirectory(c.dir, c.ref);
    if (this.budget > 0) {
      const bytes = parsedBytes(c);
      this.held.set(key, { cell, bytes });
      this.bytes += bytes;
    }
    return cell;
  }

  /**
   * Keeps at most `budget` bytes of cells. With `next`, the region a cell is next used in
   * (Infinity: none), those never used again go first, then those used furthest ahead;
   * without it, those parsed first.
   */
  trim(next?: (key: string) => number): void {
    const order = [...this.held.keys()];
    if (next) {
      const at = new Map(order.map((k) => [k, next(k)]));
      for (const k of order) {
        if (at.get(k) === Infinity) {
          this.drop(k);
        }
      }
      order.sort((a, b) => (at.get(b) as number) - (at.get(a) as number));
    }
    for (const k of order) {
      if (this.bytes <= this.budget) {
        return;
      }
      this.drop(k);
    }
  }

  private drop(key: string): void {
    const kept = this.held.get(key);
    if (kept) {
      this.held.delete(key);
      this.bytes -= kept.bytes;
    }
  }
}

/**
 * Parsed cells a build keeps between regions: a sixteenth of the heap limit `heapMb` shared by
 * `threads`, or of 1 GB without a limit. The whole Waddenzee set at a 2 GB limit on one thread
 * (x86): kept 0 MB, 97 s and 1436 MB peak RSS; 128 MB, 90 s and 1489 MB; 256 MB, 82–93 s
 * and 1755–1798 MB.
 */
export const keptParsedBytes = (heapMb: number | undefined, threads = 1): number =>
  Math.floor(((heapMb ?? 1024) * 2 ** 20) / threads / 16);
