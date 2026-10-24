import type { ServerAPI } from "@signalk/server-api";
import path from "path";
import type { CsbPlatform } from "./livechart/csb-export";
import { csbGeoJson } from "./livechart/csb-export";
import type { Discrepancy } from "./livechart/discrepancy";
import { discrepancyOf, noteId, noteOf } from "./livechart/discrepancy";
import { adjustmentSteps, NoteSchedule } from "./livechart/note-schedule";
import type { CellPosterior } from "./livechart/posterior";
import {
  adjustmentFor,
  chartPrior,
  isDiscrepancy,
  noPrior,
  Posteriors,
  raisedMark,
  rebasePrior
} from "./livechart/posterior";
import { cellRefAt } from "./livechart/restore";
import { unloadedBlock } from "./livechart/chart-blocks";
import type { Rebased } from "./livechart/settle";
import { PriorSettler, rebaseOnto } from "./livechart/settle";
import { LivechartFiles } from "./livechart/state-files";
import type { RawSounding, SoundingSource } from "./livechart/soundings";
import { reduce } from "./livechart/soundings";
import type { NodeStore } from "./spatial/node-store";
import { tileKey } from "./foundation/geo";
import type { PluginConfig } from "./config";
import type { Clock, Monitor } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";

/**
 * Living chart for the plugin (plan §4.13): own soundings update per-cell
 * posteriors; a confirmed discrepancy lowers the cell for every query and
 * becomes a Signal K note. The adjustments are kept in `livechart.json` beside
 * the index, the cells in `cells.ndjson` and the accepted soundings in
 * `soundings.ndjson`. Nothing here can make a cell deeper (safety invariant 5).
 */

export interface LivechartConfig {
  source: SoundingSource;
  writeNotes: boolean;
  csb: Omit<CsbPlatform, "transducerDepth">;
}

export interface LivechartDeps {
  setNote(id: string, body: Record<string, unknown>): Promise<void>;
  error(message: string): void;
  /** Epoch ms, for the note and save schedules; Date.now when not given. */
  now?: () => number;
  /** Droppable cells allowed before a prune, MAX_CELLS when not given; for tests. */
  maxCells?: number;
}

/** Soundings kept for the CSB export, newest last. */
export const MAX_SAMPLES = 20000;

/**
 * Cells kept (plan §4.13): once more than MAX_CELLS could be dropped, those last sounded
 * longest ago are dropped until a tenth fewer remain; see Posteriors.prune().
 */
export const MAX_CELLS = 10_000;

/**
 * The save schedule (plan §4.13): soundings are appended every minute; cells and adjustments
 * are written every 10 minutes, and at the next check, at most 10 s later, once an
 * adjustment is added or moves a 5 cm depth or 1 cm σ step.
 */
export const SAVE_CHECK_MS = 10_000;

export class LivechartService {
  private readonly posteriors: Posteriors;
  private readonly files: LivechartFiles;
  private stopTimer?: () => void;
  readonly rejected = new Map<string, number>();
  accepted = 0;
  /** Cells dropped by the retention bound since start. */
  private dropped = 0;
  private readonly maxCells: number;
  private readonly notes = new NoteSchedule((key) => this.writeNote(key));
  private readonly settler: PriorSettler;

  constructor(
    private store: NodeStore,
    private readonly config: LivechartConfig,
    file: string,
    private readonly deps: LivechartDeps
  ) {
    this.maxCells = deps.maxCells ?? MAX_CELLS;
    this.posteriors = new Posteriors(store);
    this.settler = new PriorSettler(
      this.posteriors,
      () => this.store,
      (c, changed, before) => this.settled(c, changed, before),
      deps.error
    );
    this.files = new LivechartFiles(file, MAX_SAMPLES, deps.error, this.now());
    this.files.load(store, this.posteriors);
    // Restored cells have no prior until the settler moves them onto the chart and judges them.
    this.settler.soon();
  }

  /**
   * A cell the settler moved onto the current chart: a raised protection mark is saved, the
   * cell is judged, and the note of a cell with an adjustment is brought up to date, as one
   * that waited for the chart, or that a stop left unwritten, can be behind it.
   */
  private settled(
    c: CellPosterior | undefined,
    adjustmentMoved: boolean,
    before: CellPosterior | undefined
  ): void {
    // The cells are saved as they were sounded and moved onto the chart again at each start.
    if (adjustmentMoved) {
      this.files.stateChanged();
    }
    if (!c) {
      return;
    }
    const key = tileKey(c.z, c.x, c.y);
    if (raisedMark(before, c)) {
      this.files.cellChanged(key);
    }
    if (isDiscrepancy(c)) {
      this.adjust(c);
    }
    const a = this.store.adjustments.get(key);
    if (a && this.config.writeNotes) {
      this.notes.changed(key, a, this.now());
    }
  }

  /**
   * Moves the living chart onto a rebuilt index with the same leaf zoom, as load() does for
   * a saved state: each cell is rebased onto the new chart prior and judged again.
   */
  rebind(store: NodeStore): void {
    this.applyRebind(store, () => true, new Map());
  }

  /**
   * rebind() for a running plugin, without one long block: the cells for which `affected` is
   * true are rebased in slices with `pause` after each, and the returned function, run
   * once the caller swaps the index in, moves the living chart over. A cell `affected`
   * leaves out keeps its prior, which the caller vouches is unchanged (invariant 5); a cell
   * that got a sounding meanwhile is rebased again then. Each block a cell's prior reads is
   * waited for, as chartPrior() would read its stand-ins.
   */
  async prepareRebind(
    store: NodeStore,
    affected: (c: CellPosterior) => boolean,
    pause: () => Promise<void>
  ): Promise<() => void> {
    const cells = [...this.posteriors.cells.values()].filter(affected);
    // A cell whose block could not be read is left to applyRebind().
    const done = await rebaseOnto(store, cells, pause);
    await pause();
    return () => this.applyRebind(store, affected, done);
  }

  private applyRebind(
    store: NodeStore,
    affected: (c: CellPosterior) => boolean,
    done: Map<number, Rebased>
  ): void {
    const unsettled = this.posteriors.unsettled;
    for (const [key, c] of this.posteriors.cells) {
      const d = done.get(key);
      let next: CellPosterior | undefined;
      // A cell dropped and sounded again meanwhile can have as many samples as before.
      if (d && d.samples === c.samples && d.lastAt === c.lastAt) {
        next = d.c;
        unsettled.delete(key);
      } else if (affected(c) && unloadedBlock(store, c.z, c.x, c.y) === undefined) {
        next = rebasePrior(c, chartPrior(store, c.z, c.x, c.y));
        unsettled.delete(key);
      } else if (affected(c)) {
        // Not judged until the settler finds the block loaded.
        next = rebasePrior(c, noPrior());
        unsettled.add(key);
      }
      if (next) {
        this.posteriors.cells.set(key, next);
        if (raisedMark(c, next)) {
          this.files.cellChanged(key);
        }
      }
    }
    const z = this.store.adjustZoom;
    for (const [key, v] of this.store.adjustments) {
      if (!this.posteriors.cells.has(key)) {
        unsettled.delete(key);
      }
      store.adjustments.set(key, { ...v, cellRef: cellRefAt(store, this.posteriors, z, key) });
    }
    this.store = store;
    this.posteriors.rebind(store);
    this.judge();
    this.settler.soon();
  }

  /** Adjusts every cell that is a discrepancy; adjust() only lowers. */
  private judge(): void {
    for (const c of this.posteriors.cells.values()) {
      if (isDiscrepancy(c)) {
        this.adjust(c);
      }
    }
  }

  /** Resolves when the run settling cells, if one is under way, has ended. */
  whenSettled(): Promise<void> {
    return this.settler.done();
  }

  get path(): string {
    return this.config.source.path;
  }

  onSounding(raw: RawSounding): void {
    const r = reduce(raw, this.config.source);
    if (!r.ok) {
      const reason = r.reason.replace(/[\d.]+/g, "#");
      this.rejected.set(reason, (this.rejected.get(reason) ?? 0) + 1);
      return;
    }
    this.accepted += 1;
    this.files.appendSample(r.sounding);
    const c = this.posteriors.add(r.sounding);
    this.files.cellChanged(tileKey(c.z, c.x, c.y));
    // An unsettled cell is judged against the prior it holds, the stand-ins' (never deeper than
    // the chart's) or none, and against the chart's once the settler has read it.
    this.settler.soon();
    if (isDiscrepancy(c)) {
      this.adjust(c);
    }
  }

  private adjust(c: CellPosterior): void {
    const key = tileKey(c.z, c.x, c.y);
    const previous = this.store.adjustments.get(key);
    const next = adjustmentFor(c, previous);
    if (previous && previous.dMin === next.dMin && previous.sigmaD === next.sigmaD) {
      return;
    }
    this.store.adjustments.set(key, next);
    this.files.adjustmentChanged(!previous || adjustmentSteps(previous) !== adjustmentSteps(next));
    if (this.config.writeNotes) {
      this.notes.changed(key, next, this.now());
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Writes cell `key`'s note; false, and the note waits, while the cell waits for its chart
   * block, whose depth the note would give as not charted.
   */
  private writeNote(key: number): boolean {
    if (this.posteriors.unsettled.has(key)) {
      return false;
    }
    const c = this.posteriors.cells.get(key);
    if (c) {
      this.deps
        .setNote(noteId(c), noteOf(c))
        .catch((err: Error) => this.deps.error(`note ${noteId(c)}: ${err.message}`));
    }
    return true;
  }

  /** Runs flush() on `clock` every SAVE_CHECK_MS until stop(). */
  startSaving(clock: Pick<Clock, "setInterval" | "clearInterval">): void {
    const timer = clock.setInterval(() => this.flush(), SAVE_CHECK_MS);
    this.stopTimer = () => clock.clearInterval(timer);
  }

  /** Writes every waiting note and saves, for plugin stop. */
  stop(): void {
    this.stopTimer?.();
    this.stopTimer = undefined;
    this.settler.stop();
    this.notes.flush(this.now(), true);
    this.save();
  }

  /**
   * Writes the notes, soundings and state that the schedule says are due, and drops the cells
   * past the retention bound, even when no state file can be written.
   */
  flush(): void {
    const now = this.now();
    this.notes.flush(now);
    this.settler.soon();
    const n = this.posteriors.prune(this.maxCells, this.maxCells - Math.floor(this.maxCells / 10));
    if (n > 0) {
      this.dropped += n;
      this.files.cellsDropped();
    }
    this.files.flush(now, this.posteriors.cells, this.store);
  }

  discrepancies(): Discrepancy[] {
    const n = 2 ** this.store.adjustZoom;
    return [...this.store.adjustments.keys()].flatMap((key) => {
      const c = this.posteriors.cells.get(key);
      // Its chart is not read yet: `charted` null does not mean uncharted.
      const pending = this.posteriors.unsettled.has(key) ? { pending: true as const } : {};
      return c
        ? [{ ...discrepancyOf(c), ...pending, key: `${Math.floor(key / n)}/${key % n}` }]
        : [];
    });
  }

  csb(): object {
    return csbGeoJson(this.files.samples, {
      ...this.config.csb,
      transducerDepth: this.config.source.transducerDepth
    });
  }

  status(): Record<string, unknown> {
    return {
      source: this.config.source.path,
      accepted: this.accepted,
      rejected: Object.fromEntries(this.rejected),
      cells: this.posteriors.cells.size,
      // Cells waiting for their chart block to load to be judged against it.
      unsettled: this.posteriors.unsettled.size,
      dropped: this.dropped,
      discrepancies: this.store.adjustments.size
    };
  }

  /**
   * Writes what changed: the new soundings, then the cells and `livechart.json`, each flushed
   * to the disk. A failed write is reported, not thrown, and tried again at the next save.
   */
  save(): void {
    this.files.save(this.now(), this.posteriors.cells, this.store);
  }
}

/** Creates the service when the living chart is on and feeds it the monitor's soundings. */
export function startLivechart(
  app: Pick<ServerAPI, "getDataDirPath" | "resourcesApi" | "error">,
  clock: Pick<Clock, "now" | "setInterval" | "clearInterval">,
  config: PluginConfig,
  index: ChartIndex | undefined,
  monitor: Monitor
): LivechartService | undefined {
  if (!config.livechart || !index) {
    return undefined;
  }
  const lc = new LivechartService(
    index.pyramid,
    config.livechart,
    path.join(app.getDataDirPath(), "livechart.json"),
    {
      setNote: (id, body) => app.resourcesApi.setResource("notes", id, body),
      error: (m) => app.error(m),
      now: () => clock.now()
    }
  );
  monitor.watch([lc.path], (_p, value, at) => {
    lc.onSounding({
      depth: typeof value === "number" ? value : NaN,
      at,
      ...monitor.fresh(),
      positionAt: monitor.nav.position?.at,
      waterLevel: monitor.waterLevel()
    });
  });
  lc.startSaving(clock);
  return lc;
}
