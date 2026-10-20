import type { ServerAPI } from "@signalk/server-api";
import fs from "fs";
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
  Posteriors,
  rebasePrior
} from "./livechart/posterior";
import {
  isRecord,
  isSounding,
  listOf,
  MAX_ZOOM_STEPS,
  moveAside,
  savedZoom
} from "./livechart/saved-state";
import { cellRefAt, restoreAdjustments, restoreCells } from "./livechart/restore";
import { SampleLog } from "./livechart/sample-log";
import type { RawSounding, Sounding, SoundingSource } from "./livechart/soundings";
import { reduce } from "./livechart/soundings";
import type { NodeStore, NodeValues } from "./spatial/node-store";
import { writeFileDurable } from "./foundation/durable-file";
import { tileKey } from "./foundation/geo";
import type { PluginConfig } from "./config";
import type { Clock, Monitor } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";

/**
 * Living chart for the plugin (plan §4.13): own soundings update per-cell
 * posteriors; a confirmed discrepancy lowers the cell for every query and
 * becomes a Signal K note. Cells and adjustments are kept in `livechart.json`
 * beside the index, the accepted soundings in `soundings.ndjson`. Nothing here
 * can make a cell deeper (safety invariant 5).
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
}

/** Soundings kept for the CSB export, newest last. */
export const MAX_SAMPLES = 20000;

/**
 * The save schedule (plan §4.13): soundings are appended every minute; cells and adjustments
 * are written every 10 minutes, and at the next check, at most 10 s later, once an
 * adjustment is added or moves a 5 cm depth or 1 cm σ step.
 */
export const SAVE_CHECK_MS = 10_000;
const SAMPLES_EVERY_MS = 60_000;
const STATE_EVERY_MS = 10 * 60_000;

/** Cells rebased per slice of prepareRebind(): 1 000 chart priors take about 11 ms on x86. */
const REBIND_SLICE = 1000;

/** A cell rebased onto a new prior, and its sample count then. */
interface Rebased {
  samples: number;
  c: CellPosterior;
}

interface Saved {
  version: 1;
  /** The living-chart zoom the cells and adjustment keys are at. */
  zoom: number;
  cells: CellPosterior[];
  adjustments: [number, NodeValues][];
}

export class LivechartService {
  private readonly posteriors: Posteriors;
  private readonly log: SampleLog;
  /** Cells or adjustments changed since `livechart.json` was written. */
  private dirty = false;
  /** An adjustment was added or moved a step since then: write within SAVE_CHECK_MS. */
  private adjusted = false;
  private samplesAt: number;
  private stateAt: number;
  private stopTimer?: () => void;
  readonly rejected = new Map<string, number>();
  accepted = 0;
  /** Set when a state file that did not load whole could not be moved aside: never overwrite it. */
  private keepFile = false;
  private readonly notes = new NoteSchedule((key) => this.writeNote(key));

  constructor(
    private store: NodeStore,
    private readonly config: LivechartConfig,
    private readonly file: string,
    private readonly deps: LivechartDeps
  ) {
    this.posteriors = new Posteriors(store);
    this.log = new SampleLog(path.join(path.dirname(file), "soundings.ndjson"), MAX_SAMPLES);
    this.samplesAt = this.stateAt = this.now();
    this.load();
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
   * that got a sounding meanwhile is rebased again then.
   */
  async prepareRebind(
    store: NodeStore,
    affected: (c: CellPosterior) => boolean,
    pause: () => Promise<void>
  ): Promise<() => void> {
    const done = new Map<number, Rebased>();
    let n = 0;
    for (const [key, c] of [...this.posteriors.cells]) {
      if (affected(c)) {
        done.set(key, { samples: c.samples, c: rebasePrior(c, chartPrior(store, c.z, c.x, c.y)) });
        if (++n % REBIND_SLICE === 0) {
          await pause();
        }
      }
    }
    await pause();
    return () => this.applyRebind(store, affected, done);
  }

  private applyRebind(
    store: NodeStore,
    affected: (c: CellPosterior) => boolean,
    done: Map<number, Rebased>
  ): void {
    for (const [key, c] of this.posteriors.cells) {
      const d = done.get(key);
      if (d && d.samples === c.samples) {
        this.posteriors.cells.set(key, d.c);
      } else if (affected(c)) {
        this.posteriors.cells.set(key, rebasePrior(c, chartPrior(store, c.z, c.x, c.y)));
      }
    }
    const z = this.store.adjustZoom;
    for (const [key, v] of this.store.adjustments) {
      store.adjustments.set(key, { ...v, cellRef: cellRefAt(store, this.posteriors, z, key) });
    }
    this.store = store;
    this.posteriors.rebind(store);
    for (const c of this.posteriors.cells.values()) {
      if (isDiscrepancy(c)) {
        this.adjust(c);
      }
    }
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
    this.dirty = true;
    this.log.add(r.sounding);
    const c = this.posteriors.add(r.sounding);
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
    this.dirty = true;
    this.adjusted ||= !previous || adjustmentSteps(previous) !== adjustmentSteps(next);
    if (this.config.writeNotes) {
      this.notes.changed(key, next, this.now());
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private writeNote(key: number): void {
    const c = this.posteriors.cells.get(key);
    if (c) {
      this.deps
        .setNote(noteId(c), noteOf(c))
        .catch((err: Error) => this.deps.error(`note ${noteId(c)}: ${err.message}`));
    }
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
    this.notes.flush(this.now(), true);
    this.save();
  }

  /** Writes the notes, soundings and state that the schedule says are due. */
  flush(): void {
    const now = this.now();
    this.notes.flush(now);
    // A state file that could not be set aside is never written, so it never brings the log forward.
    const state =
      !this.keepFile && this.dirty && (this.adjusted || now - this.stateAt >= STATE_EVERY_MS);
    // Soundings first: the state file may still hold soundings only the log will keep.
    if (state || now - this.samplesAt >= SAMPLES_EVERY_MS) {
      this.saveSamples(now);
    }
    if (state) {
      this.saveState(now);
    }
  }

  discrepancies(): Discrepancy[] {
    const n = 2 ** this.store.adjustZoom;
    return [...this.store.adjustments.keys()].flatMap((key) => {
      const c = this.posteriors.cells.get(key);
      return c ? [{ ...discrepancyOf(c), key: `${Math.floor(key / n)}/${key % n}` }] : [];
    });
  }

  csb(): object {
    return csbGeoJson(this.log.samples, {
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
      discrepancies: this.store.adjustments.size
    };
  }

  /**
   * Writes what changed: the new soundings, then `livechart.json`, each atomically and flushed
   * to the disk. A failed write is reported, not thrown: it runs from plugin stop and from
   * the save timer. What failed stays unsaved, so the next save tries again.
   */
  save(): void {
    const now = this.now();
    this.saveSamples(now);
    this.saveState(now);
  }

  private saveSamples(now: number): void {
    this.samplesAt = now;
    try {
      fs.mkdirSync(path.dirname(this.log.file), { recursive: true });
      this.log.save();
    } catch (err) {
      this.deps.error(`${this.log.file} not saved: ${(err as Error).message}`);
    }
  }

  private saveState(now: number): void {
    if (!this.dirty || this.keepFile) {
      return;
    }
    // A failure is retried at the next 10-minute save, not at every check.
    this.stateAt = now;
    this.adjusted = false;
    const saved: Saved = {
      version: 1,
      zoom: this.store.adjustZoom,
      cells: [...this.posteriors.cells.values()],
      adjustments: [...this.store.adjustments]
    };
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify(saved), tmp);
      this.dirty = false;
    } catch (err) {
      fs.rmSync(tmp, { force: true, recursive: true });
      this.deps.error(`${this.file} not saved: ${(err as Error).message}`);
    }
  }

  /**
   * Restores saved state; anything malformed is skipped, so a bad file never stops the plugin.
   * A file that does not load whole is moved aside first, so a later save cannot overwrite what
   * was skipped.
   */
  private load(): void {
    this.loadLog(this.loadState());
  }

  /** Restores `livechart.json`; returns the soundings a version that kept them there saved. */
  private loadState(): Sounding[] {
    const saved = this.readSaved();
    if (!saved) {
      return [];
    }
    const z = this.store.adjustZoom;
    const from = savedZoom(saved, z);
    if (from === undefined || z - from > MAX_ZOOM_STEPS) {
      this.setAside(`has zoom ${String(saved.zoom)}, which cannot be mapped onto zoom ${z}`);
      return [];
    }
    const cells = listOf(saved.cells);
    const samples = listOf(saved.samples);
    const notLists = [saved.cells, saved.adjustments, saved.samples].filter(
      (v) => v !== undefined && !Array.isArray(v)
    ).length;
    const malformed =
      notLists +
      restoreCells(cells, this.store, this.posteriors) +
      restoreAdjustments(saved.adjustments, from, this.store, this.posteriors) +
      samples.filter((v) => !isSounding(v)).length;
    // Against a rebuilt chart a cell may qualify that did not before; adjust() only lowers.
    for (const c of this.posteriors.cells.values()) {
      if (isDiscrepancy(c)) {
        this.adjust(c);
      }
    }
    // What did load is written to a new file at the next save; the old one is set aside.
    this.dirty ||= malformed > 0 || from !== z || samples.length > 0;
    if (malformed > 0) {
      this.setAside(`had ${malformed} malformed entries, skipped`);
    } else if (from !== z && cells.length > 0) {
      this.setAside(
        `was saved at zoom ${from}: its ${cells.length} cells are dropped and their ` +
          `adjustments moved onto zoom ${z}`
      );
    }
    return samples.filter(isSounding);
  }

  /**
   * Restores `soundings.ndjson` after `legacy`, the soundings `livechart.json` held, which
   * move into it at the next save. A log already holding them starts at the first of them.
   */
  private loadLog(legacy: Sounding[]): void {
    const log = this.log;
    let read: ReturnType<SampleLog["read"]>;
    try {
      read = log.read();
    } catch (err) {
      this.setAsideLog(`is not readable, starting empty: ${(err as Error).message}`);
    }
    if (read && read.malformed > 0) {
      this.setAsideLog(`had ${read.malformed} malformed lines, skipped`);
    }
    if (read?.torn) {
      this.deps.error(`${log.file}: skipped a truncated last line`);
    }
    const logged = read?.samples ?? [];
    const first = logged[0]?.at ?? Infinity;
    log.samples = [...legacy.filter((s) => s.at < first), ...logged].slice(-MAX_SAMPLES);
    log.rewrite ||= legacy.length > 0;
  }
  /** The saved state file as a version-1 record, or undefined with the reason reported. */
  private readSaved(): Record<string, unknown> | undefined {
    if (!fs.existsSync(this.file)) {
      return undefined;
    }
    let saved: unknown;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      this.setAside(`is not readable JSON, starting empty: ${(err as Error).message}`);
      return undefined;
    }
    if (!isRecord(saved)) {
      this.setAside("is not a living-chart state, starting empty");
      return undefined;
    }
    if (saved.version !== 1) {
      this.setAside(`has version ${String(saved.version)}, starting empty`);
      return undefined;
    }
    return saved;
  }

  /** Sets the state file aside; if that fails, never writes it. */
  private setAside(reason: string): void {
    this.keepFile ||= !moveAside(this.file, reason, this.deps.error);
  }

  /** Sets the sounding log aside to be rewritten; if that fails, never writes it. */
  private setAsideLog(reason: string): void {
    const moved = moveAside(this.log.file, reason, this.deps.error);
    this.log.keep ||= !moved;
    this.log.rewrite ||= moved;
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
