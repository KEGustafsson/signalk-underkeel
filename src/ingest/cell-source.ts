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
  /** Entries named like a cell that hold none the scan read, or a cell name met twice. */
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
 * file in path order; one file met again through a link counts once. A
 * directory is read again only when reached with more depth left than
 * before, and never from within itself, so a linked loop ends where it comes
 * back.
 */
export function scanCellSources(cellsDir: string | undefined): CellScan {
  const scan: CellScan = { sources: [], skipped: [] };
  if (!cellsDir) {
    return scan;
  }
  const seen = new Set<string>();
  const files = new Set<string>();
  /** Folders named like a cell, by real path: skipped unless a cell is read from under one. */
  const named = new Map<string, string>();
  /** Real paths of the folders a `.000` was met in; a linked file's target may lie elsewhere. */
  const holding = new Set<string>();
  const add = (source: string): void => {
    holding.add(fs.realpathSync(path.dirname(source)));
    const real = fs.realpathSync(source);
    if (files.has(real)) {
      return;
    }
    files.add(real);
    const name = sourceName(source);
    if (seen.has(name)) {
      scan.skipped.push(path.relative(cellsDir, source));
      return;
    }
    seen.add(name);
    scan.sources.push(source);
  };
  /** Depth left when each real directory was read, and those being read now. */
  const left = new Map<string, number>();
  const open = new Set<string>();
  const take = (dir: string, e: fs.Dirent, depth: number, limit: number): void => {
    const full = path.join(dir, e.name);
    const directory = e.isDirectory() || (e.isSymbolicLink() && isDirectory(full));
    if (directory) {
      if (usageBandFromName(e.name) !== undefined) {
        named.set(path.relative(cellsDir, full), fs.realpathSync(full));
        scan.skipped.push(path.relative(cellsDir, full));
      }
      if (depth < limit) {
        walk(full, depth + 1, limit);
      }
    } else if (isEncFile(e.name) && fs.existsSync(full)) {
      add(full);
    } else if (e.isSymbolicLink() && !fs.existsSync(full)) {
      // A dangling link is most likely a cell the user expects read.
      scan.skipped.push(path.relative(cellsDir, full));
    }
  };
  /** Reads the entries of `dir`, at `depth`, and its directories down to `deepest` (deeper below a CATALOG.031). */
  function walk(dir: string, depth: number, deepest: number): void {
    // A link back up an exchange set would otherwise raise the limit at every turn.
    const real = fs.realpathSync(dir);
    if (open.has(real) || (left.get(real) ?? -1) >= deepest - depth) {
      return;
    }
    left.set(real, deepest - depth);
    open.add(real);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const limit = entries.some((e) => isCatalogue(e.name))
      ? Math.max(deepest, depth + EXCHANGE_SET_DEPTH)
      : deepest;
    for (const e of entries) {
      if (!e.name.startsWith(".")) {
        take(dir, e, depth, limit);
      }
    }
    open.delete(real);
  }
  walk(cellsDir, 1, MAX_DEPTH);
  // Decided once every path is read: a folder reached too deep by one path may be read by another.
  const holds = (dir: string): boolean =>
    [...holding].some((d) => d === dir || d.startsWith(dir + path.sep));
  scan.skipped = scan.skipped.filter((entry) => {
    const real = named.get(entry);
    return real === undefined || !holds(real);
  });
  return scan;
}
