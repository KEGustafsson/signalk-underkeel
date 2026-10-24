import fs from "fs";
import path from "path";
import type { Ack } from "./engine/acks";
import { writeFileDurable } from "./foundation/durable-file";

/**
 * Acknowledged passages kept in `acks.json` under the plugin data
 * directory. Writes go to a temporary file, flushed to the disk and renamed
 * over the old one, so a crash or power cut leaves either the old list or
 * the new one. Expired entries are left out on read and dropped from the
 * file on the next write, so the file does not keep them for ever.
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

  /** Throws when the list cannot be saved; the live list is then unchanged. */
  add(ack: Ack, now = Date.now()): void {
    const next = [...this.list(now).filter((a) => a.id !== ack.id), ack];
    this.save(next);
    this.acks = next;
  }

  /** Returns whether an unexpired entry was removed. */
  remove(id: string, now = Date.now()): boolean {
    const live = this.list(now);
    const next = live.filter((a) => a.id !== id);
    if (next.length === live.length) {
      return false;
    }
    this.save(next);
    this.acks = next;
    return true;
  }

  private save(list: Ack[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileDurable(this.file, JSON.stringify(list, null, 2));
  }
}
