import fs from "fs";
import path from "path";
import type { ReadCell } from "./cell-reader";
import { readCellDirectory, readCellInfo } from "./cell-reader";
import type { CellInfo } from "./cells";
import { usageBandFromName } from "./cells";
import { encStamp, readEncCell } from "./enc-wasm";

/**
 * Where a cell is read from: an S-57 base cell (`.000`, its updates beside
 * it) read with gdal3.js, or a directory of GeoJSON layers, as the plugin
 * keeps the Traficom WFS cell. The cells directory holds S-57 cells only.
 */

export const isEncFile = (source: string): boolean => /\.000$/i.test(source);

/** The cell's name: an S-57 cell's from its file name, the DSID's for a directory. */
export function sourceName(source: string): string {
  return isEncFile(source)
    ? path.basename(source, path.extname(source))
    : readCellInfo(source).name;
}

/**
 * What tells whether the cell at `source` changed since an index was saved,
 * read without GDAL: an S-57 cell's name and files' stamp, a directory's DSID
 * and datum areas.
 */
export function currentInfo(source: string): Partial<CellInfo> {
  return isEncFile(source)
    ? { name: sourceName(source), files: encStamp(source) }
    : readCellInfo(source);
}

export function readCell(source: string, cellRef: number): Promise<ReadCell> {
  return isEncFile(source)
    ? readEncCell(source, cellRef)
    : Promise.resolve(readCellDirectory(source, cellRef));
}

export interface CellScan {
  /** S-57 base cells in path order. */
  sources: string[];
  /** Entries named like a cell that hold none, or a cell name met twice. */
  skipped: string[];
}

/** How deep below the cells directory S-57 cells are looked for: ENC_ROOT/<cell>/<cell>.000. */
const MAX_DEPTH = 4;

/**
 * How many folders below an exchange set's root, the directory holding its
 * CATALOG.031, a cell may sit (as MAX_DEPTH − 1 below the cells directory).
 * S-57 leaves the layout under it to the producer: Rijkswaterstaat's Inland
 * ENC sets hold ENC_ROOT/1R/7/1R7WAD07/1R7WAD07.000, three folders down.
 */
const EXCHANGE_SET_DEPTH = 6;

const isCatalogue = (name: string): boolean => /^catalog\.031$/i.test(name);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The S-57 cells under `cellsDir`: every `.000` file down to MAX_DEPTH, such
 * as in an ENC_ROOT exchange set, and down to EXCHANGE_SET_DEPTH below any
 * directory holding a CATALOG.031 within it. A name met twice keeps its first
 * file in path order. Each directory is read once by its real path, so a
 * linked loop ends where it comes back.
 */
export function scanCellSources(cellsDir: string | undefined): CellScan {
  const scan: CellScan = { sources: [], skipped: [] };
  if (!cellsDir) {
    return scan;
  }
  const seen = new Set<string>();
  const add = (source: string): void => {
    const name = sourceName(source);
    if (seen.has(name)) {
      scan.skipped.push(path.relative(cellsDir, source));
      return;
    }
    seen.add(name);
    scan.sources.push(source);
  };
  const visited = new Set<string>();
  /** Reads the entries of `dir`, at `depth`, and its directories down to `deepest` (deeper below a CATALOG.031). */
  const walk = (dir: string, depth: number, deepest: number): void => {
    // A link back up an exchange set would otherwise raise the limit at every turn.
    const real = fs.realpathSync(dir);
    if (visited.has(real)) {
      return;
    }
    visited.add(real);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const limit = entries.some((e) => isCatalogue(e.name))
      ? Math.max(deepest, depth + EXCHANGE_SET_DEPTH)
      : deepest;
    for (const e of entries) {
      if (e.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, e.name);
      const directory = e.isDirectory() || (e.isSymbolicLink() && isDirectory(full));
      if (directory) {
        const before = scan.sources.length;
        if (depth < limit) {
          walk(full, depth + 1, limit);
        }
        if (scan.sources.length === before && usageBandFromName(e.name) !== undefined) {
          scan.skipped.push(path.relative(cellsDir, full));
        }
      } else if (isEncFile(e.name) && fs.existsSync(full)) {
        add(full);
      } else if (e.isSymbolicLink() && !fs.existsSync(full)) {
        // A dangling link is most likely a cell the user expects read.
        scan.skipped.push(path.relative(cellsDir, full));
      }
    }
  };
  walk(cellsDir, 1, MAX_DEPTH);
  return scan;
}
