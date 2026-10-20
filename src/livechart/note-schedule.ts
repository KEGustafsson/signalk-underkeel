import type { NodeValues } from "../spatial/node-store";

/**
 * When a discrepancy cell's Signal K note is rewritten. Each write is a file on the server
 * and a resource delta, and a shoal being crossed lowers its adjustment with nearly every
 * reading, so a note is rewritten only when the depth it is judged by drops to a lower 5 cm
 * step or its σ rises to a higher 1 cm step, and at most once per cell every 5 minutes; a
 * change inside that window is written with the latest values once it is over.
 */

export const NOTE_EVERY_MS = 5 * 60_000;

/** The 5 cm depth step and 1 cm σ step of an adjustment. */
export const adjustmentSteps = (v: NodeValues): string =>
  `${Math.floor(v.dMin * 20)}/${Math.ceil(v.sigmaD * 100)}`;

export class NoteSchedule {
  private readonly written = new Map<number, { at: number; steps: string }>();
  private readonly waiting = new Map<number, string>();

  /** `write` writes the note for living-chart cell `key` with its current values. */
  constructor(private readonly write: (key: number) => void) {}

  /** Cell `key`'s adjustment changed to `v`. */
  changed(key: number, v: NodeValues, now: number): void {
    const s = adjustmentSteps(v);
    const last = this.written.get(key);
    if (last?.steps === s) {
      this.waiting.delete(key);
    } else if (!last || now - last.at >= NOTE_EVERY_MS) {
      this.writeNow(key, s, now);
    } else {
      this.waiting.set(key, s);
    }
  }

  /** Writes the waiting notes whose 5 minutes are over, or all of them. */
  flush(now: number, all = false): void {
    for (const [key, s] of this.waiting) {
      const last = this.written.get(key);
      if (all || !last || now - last.at >= NOTE_EVERY_MS) {
        this.writeNow(key, s, now);
      }
    }
  }

  private writeNow(key: number, s: string, now: number): void {
    this.waiting.delete(key);
    this.written.set(key, { at: now, steps: s });
    this.write(key);
  }
}
