import fs from "fs";
import path from "path";
import { writeFileDurable } from "./foundation/durable-file";
import { FixHistory } from "./model/fix-history";

/**
 * The demonstrated fix quality (`model/fix-history.ts`) kept in `fix-history.json` under the
 * plugin data directory, so a restart does not forget the days it covers. Saved at most every
 * SAVE_MS while samples come in, and when the plugin stops; written to a temporary file, flushed
 * and renamed over the old one, as `ack-store.ts` does.
 */

/** How often a changed history is saved, ms. */
export const SAVE_MS = 10 * 60_000;

export class FixHistoryStore {
  readonly history: FixHistory;
  /** Why the file could not be read; the history then starts empty. */
  readonly error?: string;
  private saved = -Infinity;

  constructor(private readonly file: string) {
    let raw: unknown;
    if (fs.existsSync(file)) {
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      } catch (err) {
        this.error = `${file} is not readable JSON: ${(err as Error).message}`;
      }
    }
    this.history = FixHistory.from(raw);
  }

  /** Saves the history when it changed and SAVE_MS passed, or at once with `force`. */
  save(now: number, force = false): void {
    if (!this.history.dirty || (!force && now - this.saved < SAVE_MS)) {
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileDurable(this.file, JSON.stringify(this.history.toJSON()));
    this.history.dirty = false;
    this.saved = now;
  }
}
