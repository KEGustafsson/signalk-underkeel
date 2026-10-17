import fs from "fs";
import path from "path";
import type { Ack } from "./engine/acks";

/**
 * Acknowledged passages kept in `acks.json` under the plugin data
 * directory. Writes go to a temporary file renamed over the old one, so a
 * crash leaves either the old list or the new one. Expired entries are
 * dropped on read.
 */

function isAck(v: unknown): v is Ack {
  const a = v as Partial<Ack> | null;
  return (
    typeof a?.id === "string" &&
    typeof a.created === "string" &&
    (a.expires === undefined || typeof a.expires === "string") &&
    Array.isArray(a.polygon) &&
    a.polygon.length >= 3 &&
    a.polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) &&
    [a.heading, a.sector, a.waterLevel, a.draft].every(
      (n) => typeof n === "number" && Number.isFinite(n)
    )
  );
}

export class AckStore {
  private acks: Ack[];

  /** Entries the file held that were malformed and dropped, for the status report. */
  readonly dropped: number;
  /** Why the file could not be read; the store then starts empty. */
  readonly error?: string;

  constructor(private readonly file: string) {
    let raw: unknown = [];
    if (fs.existsSync(file)) {
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      } catch (err) {
        this.error = `${file} is not readable JSON: ${(err as Error).message}`;
      }
    }
    const list = Array.isArray(raw) ? raw : [];
    this.acks = list.filter(isAck);
    this.dropped = list.length - this.acks.length;
  }

  list(now: number): Ack[] {
    return this.acks.filter((a) => a.expires === undefined || Date.parse(a.expires) > now);
  }

  add(ack: Ack): void {
    this.acks = [...this.acks.filter((a) => a.id !== ack.id), ack];
    this.save();
  }

  /** Returns whether an entry was removed. */
  remove(id: string): boolean {
    const before = this.acks.length;
    this.acks = this.acks.filter((a) => a.id !== id);
    if (this.acks.length === before) {
      return false;
    }
    this.save();
    return true;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.acks, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
