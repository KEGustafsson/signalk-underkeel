import fs from "fs";
import { appendFileDurable, writeFileDurable } from "../foundation/durable-file";
import { tileKey } from "../foundation/geo";
import { ndjson, readNdjson } from "./ndjson";
import type { CellPosterior } from "./posterior";
import { isCell } from "./saved-state";

/**
 * The cell posteriors in the append-only `cells.ndjson`, one cell per line, the last line for
 * a cell holding it (plan §4.13). A save appends only the cells that changed since the last
 * one; once the file would hold more than twice as many lines as the larger of its cell count
 * and `minLines`, or after cells were dropped, it is rewritten with the current cells.
 * Rewriting every cell every 10 minutes wrote the whole history for one cell sounded at anchor.
 */

/** The fewest lines a rewrite allows for, so a small chart is not rewritten at every save. */
export const CELL_LOG_MIN_LINES = 1000;

export interface CellLogRead {
  cells: Map<number, CellPosterior>;
  malformed: number;
  /** The last line had no newline and did not read: an append cut short. */
  torn: boolean;
  /** Cells at another living-chart zoom, not restored: the first such zoom and their count. */
  otherZoom?: { zoom: number; count: number };
}

export class CellLog {
  private lines = 0;
  /** Rewrite the file whole at the next save, rather than append to it. */
  rewrite = false;
  /** The file did not read whole and could not be moved aside: never write it. */
  keep = false;

  constructor(
    readonly file: string,
    private readonly minLines = CELL_LOG_MIN_LINES
  ) {}

  /**
   * Writes the `changed` cells of `cells`, or all of them when the file is due a rewrite;
   * returns whether it rewrote the file whole. Throws when it cannot write.
   */
  save(cells: ReadonlyMap<number, CellPosterior>, changed: ReadonlySet<number>): boolean {
    if (this.keep || (changed.size === 0 && !this.rewrite)) {
      return false;
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    const whole =
      this.rewrite || this.lines + changed.size > 2 * Math.max(cells.size, this.minLines);
    try {
      if (whole) {
        writeFileDurable(this.file, ndjson([...cells.values()]), tmp);
        this.lines = cells.size;
      } else {
        const lines = [...changed].flatMap((k) => cells.get(k) ?? []);
        appendFileDurable(this.file, ndjson(lines));
        this.lines += lines.length;
      }
    } catch (err) {
      fs.rmSync(tmp, { force: true, recursive: true });
      // A failed append can leave a torn line; the next save replaces the file.
      this.rewrite = true;
      throw err;
    }
    this.rewrite = false;
    return whole;
  }

  /**
   * Reads the file when there is one, the last line for each cell winning; cells at zoom other
   * than `z` are counted, not restored. Throws when the file cannot be read.
   */
  read(z: number): CellLogRead | undefined {
    const read = readNdjson(this.file, (v) => (isCell(v) ? v : undefined));
    if (!read) {
      return undefined;
    }
    this.lines = read.lines;
    this.rewrite ||= read.partial;
    const out: CellLogRead = { cells: new Map(), malformed: read.malformed, torn: read.torn };
    const other = new Set<string>();
    for (const c of read.items) {
      if (c.z === z) {
        out.cells.set(tileKey(c.z, c.x, c.y), c);
      } else {
        other.add(`${c.z}/${c.x}/${c.y}`);
        out.otherZoom = { zoom: out.otherZoom?.zoom ?? c.z, count: other.size };
      }
    }
    return out;
  }
}
