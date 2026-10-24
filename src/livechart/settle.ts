import { tileKey } from "../foundation/geo";
import type { NodeStore } from "../spatial/node-store";
import { withBlocksLoaded } from "./chart-blocks";
import type { CellPosterior, Posteriors } from "./posterior";
import { chartPrior, rebasePrior } from "./posterior";

/**
 * Moving living-chart cells onto the chart priors of an index read block by block (plan
 * §4.13), each once the block it reads is loaded, in slices so no long block of the event loop.
 */

/** Cells rebased per slice: 1 000 chart priors take about 11 ms on x86. */
const SLICE = 1000;

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A cell rebased onto a new prior, and its sample count and last sounding then. */
export interface Rebased {
  samples: number;
  lastAt: number;
  c: CellPosterior;
}

/**
 * `cells` rebased onto `store`'s priors, with `pause` after each slice; a cell whose block
 * could not be read is left out.
 */
export async function rebaseOnto(
  store: NodeStore,
  cells: readonly CellPosterior[],
  pause: () => Promise<void>
): Promise<Map<number, Rebased>> {
  const done = new Map<number, Rebased>();
  const rebase = (c: CellPosterior) =>
    done.set(tileKey(c.z, c.x, c.y), {
      samples: c.samples,
      lastAt: c.lastAt,
      c: rebasePrior(c, chartPrior(store, c.z, c.x, c.y))
    });
  await withBlocksLoaded(store, cells, rebase, { slice: SLICE, pause });
  return done;
}

/**
 * Settles the living chart's unsettled cells (`Posteriors.unsettled`) onto the current index
 * in the background: a cell is rebased onto its chart prior and its adjustment takes the
 * current cell reference, then `settled` judges it. One run at a time; a block that cannot be
 * read now is tried again at the next soon(), and a rebind or stop() ends the run.
 */
export class PriorSettler {
  private run?: Promise<void>;
  private pending = false;
  private stopped = false;

  constructor(
    private readonly posteriors: Posteriors,
    private readonly current: () => NodeStore,
    /**
     * A cell settled: its posterior if it has one, whether its adjustment took a new cell
     * reference, and the posterior before.
     */
    private readonly settled: (
      c: CellPosterior | undefined,
      adjustmentMoved: boolean,
      before: CellPosterior | undefined
    ) => void,
    private readonly error: (message: string) => void
  ) {}

  /**
   * Starts a run unless no cell waits. One asked for during a run follows it, since the run
   * settles only the cells waiting when it began; cells it could not settle are not retried
   * on their own, so a block refused for good is not read again and again.
   */
  soon(): void {
    if (this.run) {
      this.pending = true;
      return;
    }
    if (this.stopped || this.posteriors.unsettled.size === 0) {
      return;
    }
    const store = this.current();
    this.run = this.settle(store)
      .catch((err: Error) => this.error(`living chart priors: ${err.message}`))
      .finally(() => {
        this.run = undefined;
        // A rebind ended the run, or a cell came to wait while it ran.
        const again = this.pending || this.current() !== store;
        this.pending = false;
        if (again) {
          this.soon();
        }
      });
  }

  stop(): void {
    this.stopped = true;
  }

  /** Resolves when the run under way, if any, has ended. */
  done(): Promise<void> {
    return this.run ?? Promise.resolve();
  }

  private async settle(store: NodeStore): Promise<void> {
    const live = () => !this.stopped && this.current() === store;
    // Never in the turn that asked: a start, a rebind or a sounding reads no chart prior.
    await nextTurn();
    if (!live()) {
      return;
    }
    const z = store.adjustZoom;
    const n = 2 ** z;
    const cells = [...this.posteriors.unsettled].map((key) => ({
      key,
      z,
      x: Math.floor(key / n),
      y: key % n
    }));
    const settle = (c: { key: number; x: number; y: number }) => {
      if (this.posteriors.unsettled.has(c.key)) {
        this.settleCell(store, c.key, c.x, c.y);
      }
    };
    await withBlocksLoaded(store, cells, settle, { slice: SLICE, pause: nextTurn, live });
  }

  private settleCell(store: NodeStore, key: number, x: number, y: number): void {
    const prior = chartPrior(store, store.adjustZoom, x, y);
    this.posteriors.unsettled.delete(key);
    const old = this.posteriors.cells.get(key);
    const c = old && rebasePrior(old, prior);
    if (c) {
      this.posteriors.cells.set(key, c);
    }
    const a = store.adjustments.get(key);
    const cellRef = c?.cellRef ?? prior.cellRef;
    if (a && a.cellRef !== cellRef) {
      store.adjustments.set(key, { ...a, cellRef });
    }
    this.settled(c, a !== undefined && a.cellRef !== cellRef, old);
  }
}
