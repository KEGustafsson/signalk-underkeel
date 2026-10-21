import type { UnderKeelState } from "./foundation/state";

/**
 * The escape fan (plan §4.8) searched after a tick's result is published,
 * so the tick and the search block the server's event loop as two pieces.
 * After a tick or a search slower than SLOW_TICK_MS the next search is
 * skipped and the heading cleared, and `skipped` says why for the status.
 */

/** The escape fan is searched at most once in this many ms; the heading is held between. */
export const ESCAPE_EVERY_MS = 3000;

/** A tick or search longer than this skips the next search, ms. */
export const SLOW_TICK_MS = 250;

export interface Deferral {
  now(): number;
  /** Runs `fn` once the current callback returns; without it `fn` runs at once. */
  defer?(fn: () => void): unknown;
  cancel?(handle: unknown): void;
}

export class EscapeSearch {
  heading: number | null = null;
  /** Why no search runs now; undefined while searches run. */
  skipped?: string;
  private at = -Infinity;
  private slowMs = 0;
  private pending?: unknown;
  private stopped = false;

  constructor(
    private readonly clock: Deferral,
    private readonly search: () => number | null,
    private readonly publish: (heading: number | null) => void
  ) {}

  /** The heading a tick whose engine state is `state` publishes: none once the danger has passed. */
  headingFor(state: UnderKeelState): number | null {
    return calm(state) ? null : this.heading;
  }

  /** After a tick whose engine state was `state` and which took `tickMs`. */
  after(state: UnderKeelState, tickMs: number): void {
    if (calm(state)) {
      this.heading = null;
      this.at = -Infinity;
      this.skipped = undefined;
      return;
    }
    const slow = Math.max(tickMs, this.slowMs);
    this.slowMs = 0;
    if (slow > SLOW_TICK_MS) {
      this.skipped = `escape search skipped: a tick took ${slow.toFixed(0)} ms`;
      this.at = -Infinity;
      if (this.heading !== null) {
        // The tick already went out with the heading; clear it now, not a tick later.
        this.heading = null;
        this.publish(null);
      }
      return;
    }
    this.skipped = undefined;
    const now = this.clock.now();
    if (now - this.at < ESCAPE_EVERY_MS || this.pending !== undefined) {
      return;
    }
    this.at = now;
    const run = (): void => {
      this.pending = undefined;
      if (this.stopped) {
        return;
      }
      const t0 = this.clock.now();
      this.heading = this.search();
      this.slowMs = this.clock.now() - t0;
      this.publish(this.heading);
    };
    if (this.clock.defer) {
      this.pending = this.clock.defer(run);
    } else {
      run();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.pending !== undefined) {
      this.clock.cancel?.(this.pending);
      this.pending = undefined;
    }
  }
}

const calm = (state: UnderKeelState): boolean =>
  state === "normal" || state === "unknown" || state === "off";
