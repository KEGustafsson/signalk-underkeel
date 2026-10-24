import type { UnderKeelState } from "./foundation/state";

/**
 * The escape fan (plan §4.8) searched after a tick's result is published,
 * so the tick and the search block the server's event loop as two pieces.
 * After a tick slower than SLOW_TICK_MS the next search is skipped and the
 * heading cleared, and `skipped` says why for the status until a search
 * runs again. After a search that slow its fresh heading is kept, as any
 * heading is between searches, and `skipped` says so until a search is
 * fast again. Either restarts the ESCAPE_EVERY_MS wait, so a search that is
 * always slow runs less often, not more.
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
  /** Why searches are skipped or spaced out; undefined while they run on time. */
  skipped?: string;
  private at = -Infinity;
  /** How long the last search took, until the tick after it reads it, ms. */
  private slowMs = 0;
  private searchSlow = false;
  private pending?: unknown;
  /** Bumped to void a search queued before it; a deferral may have no cancel. */
  private generation = 0;
  private stopped = false;

  constructor(
    private readonly clock: Deferral,
    private readonly search: () => number | null,
    private readonly publish: (heading: number | null) => void
  ) {}

  /**
   * The heading a tick whose engine state is `state` publishes: none once the
   * danger has passed, nor while the tick is not `escapable` (low speed or a
   * capped position buffer, where any heading would be a guess).
   */
  headingFor(state: UnderKeelState, escapable = true): number | null {
    return idle(state, escapable) ? null : this.heading;
  }

  /** After a tick whose engine state was `state` and which took `tickMs`. */
  after(state: UnderKeelState, tickMs: number, escapable = true): void {
    if (idle(state, escapable)) {
      this.reset();
      return;
    }
    const now = this.clock.now();
    const searchMs = this.slowMs;
    this.slowMs = 0;
    if (tickMs > SLOW_TICK_MS) {
      this.skipped = `escape search skipped: a tick took ${tickMs.toFixed(0)} ms`;
      this.at = now;
      if (this.heading !== null) {
        // The tick already went out with the heading; clear it now, not a tick later.
        this.heading = null;
        this.publish(null);
      }
      return;
    }
    if (searchMs > SLOW_TICK_MS) {
      // The heading the slow search just found is no staler than one held
      // between searches: keep it, and only push the next search back.
      this.at = now;
      return;
    }
    if (now - this.at < ESCAPE_EVERY_MS || this.pending !== undefined) {
      return;
    }
    // A skip after a slow tick ends here; a slow search's note waits for a fast one.
    if (!this.searchSlow) {
      this.skipped = undefined;
    }
    this.at = now;
    const generation = this.generation;
    const run = (): void => {
      if (this.stopped || generation !== this.generation) {
        return;
      }
      this.pending = undefined;
      const t0 = this.clock.now();
      this.heading = this.search();
      this.slowMs = this.clock.now() - t0;
      this.searchSlow = this.slowMs > SLOW_TICK_MS;
      this.skipped = this.searchSlow
        ? `escape search slowed: a search took ${this.slowMs.toFixed(0)} ms`
        : undefined;
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
    this.drop();
  }

  /** Once the danger has passed: no heading, no queued search, and the next one runs at once. */
  private reset(): void {
    this.heading = null;
    this.at = -Infinity;
    this.skipped = undefined;
    this.slowMs = 0;
    this.searchSlow = false;
    this.drop();
  }

  /** Cancels a queued search, and voids it where the deferral cannot cancel. */
  private drop(): void {
    this.generation++;
    if (this.pending !== undefined) {
      this.clock.cancel?.(this.pending);
      this.pending = undefined;
    }
  }
}

const idle = (state: UnderKeelState, escapable: boolean): boolean =>
  !escapable || state === "normal" || state === "unknown" || state === "off";
