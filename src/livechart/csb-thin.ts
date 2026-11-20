/**
 * Which accepted soundings go to the CSB export log (`soundings.ndjson`). A sounder at 10 Hz
 * on a moored boat put 36 000 lines an hour into the log, which is rewritten whole at 40 000
 * lines: every 33 minutes on flash. Below CSB_SLOW_SOG the log keeps one sounding per cell
 * per CSB_CELL_INTERVAL_MS; at speed it keeps every one. Only the export is thinned: every
 * accepted sounding still updates its cell's posterior (safety invariant 5). A sounding taken
 * at more water than any the cell logged in that interval is logged too, so the log keeps the
 * highest water level the boat was at, which its own tracks are listed by (`tracks.ts`).
 */

/** 1 kn, m/s. At or above it every sounding is logged; below it, or with no fresh SOG, thinned. */
export const CSB_SLOW_SOG = 1852 / 3600;

/** Below CSB_SLOW_SOG, a cell logs at most one sounding this often, ms. */
export const CSB_CELL_INTERVAL_MS = 60_000;

/** Cells remembered before those logged over CSB_CELL_INTERVAL_MS ago are forgotten. */
const MAX_TRACKED = 1024;

export class CsbThinner {
  /** When each cell last logged a sounding, epoch ms. */
  private readonly lastKept = new Map<number, number>();
  /** The highest water level each cell logged since then, metres. */
  private readonly highest = new Map<number, number>();

  /**
   * Whether the sounding at `at` in cell `cell`, with fresh SOG `sog` (m/s), taken at water
   * level `level` (metres above datum), is logged.
   */
  keep(cell: number, at: number, sog: number | undefined, level?: number): boolean {
    const last = this.lastKept.get(cell);
    const slow = sog === undefined || !(sog >= CSB_SLOW_SOG);
    // A clock that went back by more than the interval logs again rather than waiting.
    if (slow && last !== undefined && Math.abs(at - last) < CSB_CELL_INTERVAL_MS) {
      const high = this.highest.get(cell);
      if (level === undefined || (high !== undefined && level <= high)) {
        return false;
      }
      this.highest.set(cell, level);
      return true;
    }
    this.lastKept.set(cell, at);
    if (level !== undefined) {
      this.highest.set(cell, level);
    }
    if (this.lastKept.size > MAX_TRACKED) {
      for (const [key, t] of this.lastKept) {
        if (Math.abs(at - t) >= CSB_CELL_INTERVAL_MS) {
          this.lastKept.delete(key);
          this.highest.delete(key);
        }
      }
    }
    return true;
  }
}
