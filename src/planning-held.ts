import type { Bbox } from "./ingest/wfs";
import type { ChartIndex } from "./spatial/chart-index";
import type { HeldBox } from "./planning-box";

/** A planning index held, its readers counted, and the waits planning jobs make. */

export function realWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export class Held implements HeldBox {
  live = true;
  usedAt: number;
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    readonly region: Bbox,
    readonly bbox: Bbox,
    readonly parts: readonly Bbox[] | undefined,
    readonly index: ChartIndex,
    now: number
  ) {
    this.usedAt = now;
  }

  begin(): boolean {
    if (!this.live) {
      return false;
    }
    this.active++;
    return true;
  }

  end(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) {
      this.waiters.splice(0).forEach((w) => w());
    }
  }

  isIdle(): boolean {
    return this.active === 0;
  }

  /** Settles once no counted job reads the index. */
  idle(): Promise<void> {
    return this.active === 0 ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }
}

/** `p`'s outcome, or a rejection once `signal` aborts first; its listener is removed either way. */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const stop = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
