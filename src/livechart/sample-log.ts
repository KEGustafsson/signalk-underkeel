import fs from "fs";
import { appendFileDurable, writeFileDurable } from "../foundation/durable-file";
import { isSounding } from "./saved-state";
import type { Sounding } from "./soundings";

/**
 * The accepted soundings for the CSB export, newest last: the newest `max` in memory and in
 * the append-only `soundings.ndjson`, one per line. A save appends only the soundings
 * accepted since the last one; once the file would hold more than twice `max` lines it is
 * rewritten with the newest `max`. Rewriting all of them every minute was 3.2 MB per save.
 */

const lines = (samples: readonly Sounding[]): string =>
  samples.map((s) => JSON.stringify(s)).join("\n") + "\n";

export interface LogRead {
  samples: Sounding[];
  malformed: number;
  /** The last line had no newline and did not read: an append cut short. */
  torn: boolean;
}

export class SampleLog {
  samples: Sounding[] = [];
  private unsaved = 0;
  private lines = 0;
  /** Rewrite the file whole at the next save, rather than append to it. */
  rewrite = false;
  /** The file did not read whole and could not be moved aside: never write it. */
  keep = false;

  constructor(
    readonly file: string,
    private readonly max: number
  ) {}

  add(s: Sounding): void {
    this.samples.push(s);
    if (this.samples.length > this.max) {
      this.samples.splice(0, this.samples.length - this.max);
    }
    this.unsaved = Math.min(this.unsaved + 1, this.max);
  }

  /** Writes what is new since the last save; throws when it cannot. */
  save(): void {
    if (this.keep || (this.unsaved === 0 && !this.rewrite)) {
      return;
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      if (this.rewrite || this.lines + this.unsaved > 2 * this.max) {
        writeFileDurable(this.file, lines(this.samples), tmp);
        this.lines = this.samples.length;
      } else {
        appendFileDurable(this.file, lines(this.samples.slice(-this.unsaved)));
        this.lines += this.unsaved;
      }
    } catch (err) {
      fs.rmSync(tmp, { force: true, recursive: true });
      // A failed append can leave a torn line; the next save replaces the file.
      this.rewrite = true;
      throw err;
    }
    this.unsaved = 0;
    this.rewrite = false;
  }

  /** Reads the file when there is one; throws when it cannot be read. */
  read(): LogRead | undefined {
    if (!fs.existsSync(this.file)) {
      return undefined;
    }
    const parts = fs.readFileSync(this.file, "utf8").split("\n");
    // "" when the file ends with a newline, as every complete append does.
    const tail = parts.pop() ?? "";
    const read: LogRead = { samples: [], malformed: 0, torn: false };
    for (const line of parts) {
      const s = parse(line);
      if (s) {
        read.samples.push(s);
      } else {
        read.malformed++;
      }
    }
    if (tail !== "") {
      const s = parse(tail);
      read.torn = !s;
      if (s) {
        read.samples.push(s);
      }
      this.rewrite = true;
    }
    this.lines = parts.length;
    return read;
  }
}

function parse(line: string): Sounding | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return isSounding(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
