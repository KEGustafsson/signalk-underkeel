import fs from "fs";
import path from "path";
import { writeFileDurable } from "../foundation/durable-file";
import { tileKey } from "../foundation/geo";
import type { NodeStore, NodeValues } from "../spatial/node-store";
import type { CellLogRead } from "./cell-log";
import { CellLog } from "./cell-log";
import type { CellPosterior, Posteriors } from "./posterior";
import { restoreAdjustments, restoreCells } from "./restore";
import { SampleLog } from "./sample-log";
import {
  isCell,
  isRecord,
  isSounding,
  listOf,
  MAX_ZOOM_STEPS,
  moveAside,
  savedZoom
} from "./saved-state";
import type { Sounding } from "./soundings";

/**
 * The living chart's files beside the index (plan §4.13): the adjustments in `livechart.json`,
 * the cell posteriors in the append-only `cells.ndjson` and the accepted soundings in
 * `soundings.ndjson`. A file that did not load whole is moved aside before anything is saved
 * over it, and never written when it cannot be.
 */

/** Soundings are appended every minute; cells and adjustments are saved every 10 minutes. */
export const SAMPLES_EVERY_MS = 60_000;
export const STATE_EVERY_MS = 10 * 60_000;

interface Saved {
  version: 1;
  /** The living-chart zoom the adjustment keys are at. */
  zoom: number;
  adjustments: [number, NodeValues][];
  /** The cells, while `cells.ndjson` does not hold them durably; an older version kept them here. */
  cells?: CellPosterior[];
  /** Soundings of an older version's file that the log does not hold yet. */
  samples?: Sounding[];
}

export class LivechartFiles {
  private readonly log: SampleLog;
  private readonly cellLog: CellLog;
  /** `livechart.json` must be rewritten: its zoom, adjustments or cells changed. */
  private dirty = false;
  /** An adjustment was added or moved a step since then: write within the next check. */
  private adjusted = false;
  private samplesAt: number;
  private stateAt: number;
  /** Set when a state file that did not load whole could not be moved aside: never overwrite it. */
  private keepFile = false;
  /**
   * Soundings an older version's `livechart.json` held and the log does not: written back
   * with the state until a log save holds them, so a failed one never loses them.
   */
  private legacy: Sounding[] = [];
  /** Cells sounded, or whose protection mark a rebase raised, since the last state save. */
  private readonly changed = new Set<number>();
  /** `livechart.json` carries the cells, because `cells.ndjson` does not hold them durably. */
  private cellsInState = false;

  constructor(
    readonly file: string,
    private readonly maxSamples: number,
    private readonly error: (message: string) => void,
    now: number
  ) {
    const dir = path.dirname(file);
    this.log = new SampleLog(path.join(dir, "soundings.ndjson"), maxSamples);
    this.cellLog = new CellLog(path.join(dir, "cells.ndjson"));
    this.samplesAt = this.stateAt = now;
  }

  /** The soundings kept for the CSB export, newest last. */
  get samples(): readonly Sounding[] {
    return this.log.samples;
  }

  appendSample(s: Sounding): void {
    this.log.add(s);
  }

  cellChanged(key: number): void {
    this.changed.add(key);
  }

  /** Cells were dropped: the cell log is rewritten without them at the next state save. */
  cellsDropped(): void {
    this.cellLog.rewrite = true;
    this.dirty ||= this.cellsInState;
  }

  stateChanged(): void {
    this.dirty = true;
  }

  /** An adjustment changed; `stepMoved` when it is new or moved a step, to be saved soon. */
  adjustmentChanged(stepMoved: boolean): void {
    this.dirty = true;
    this.adjusted ||= stepMoved;
  }

  private unsaved(): boolean {
    return this.dirty || this.changed.size > 0 || this.cellLog.rewrite;
  }

  /** Writes the soundings and state that the schedule says are due. */
  flush(now: number, cells: ReadonlyMap<number, CellPosterior>, store: NodeStore): void {
    // A state file that could not be set aside is never written, so it never brings the log forward.
    const state =
      !this.keepFile && this.unsaved() && (this.adjusted || now - this.stateAt >= STATE_EVERY_MS);
    // Soundings first: the state file keeps an older version's soundings until the log does.
    if (state || now - this.samplesAt >= SAMPLES_EVERY_MS) {
      this.saveSamples(now);
    }
    if (state) {
      this.saveState(now, cells, store);
    }
  }

  /**
   * Writes what changed: the new soundings, then the cells and `livechart.json`, each flushed
   * to the disk. A failed write is reported, not thrown: it runs from plugin stop and from
   * the save timer. What failed stays unsaved, so the next save tries again.
   */
  save(now: number, cells: ReadonlyMap<number, CellPosterior>, store: NodeStore): void {
    this.saveSamples(now);
    this.saveState(now, cells, store);
  }

  private saveSamples(now: number): void {
    this.samplesAt = now;
    try {
      fs.mkdirSync(path.dirname(this.log.file), { recursive: true });
      this.log.save();
      if (!this.log.keep && this.legacy.length > 0) {
        // Held by the log now: livechart.json is written without them.
        this.legacy = [];
        this.dirty = true;
      }
    } catch (err) {
      this.error(`${this.log.file} not saved: ${(err as Error).message}`);
    }
  }

  /**
   * The cells first, then `livechart.json`, which drops the cells it carried only once a whole
   * `cells.ndjson` is on the disk; a cut between the two leaves both holding them.
   */
  private saveState(
    now: number,
    cells: ReadonlyMap<number, CellPosterior>,
    store: NodeStore
  ): void {
    if (this.keepFile || !this.unsaved()) {
      return;
    }
    // A failure is retried at the next 10-minute save, not at every check.
    this.stateAt = now;
    this.adjusted = false;
    this.dirty ||= this.cellsInState && this.changed.size > 0;
    if (this.cellLog.keep) {
      // The cells travel in livechart.json.
      this.changed.clear();
    } else {
      try {
        fs.mkdirSync(path.dirname(this.cellLog.file), { recursive: true });
        const whole = this.cellLog.save(cells, this.changed);
        this.changed.clear();
        if (whole && this.cellsInState) {
          this.cellsInState = false;
          this.dirty = true;
        }
      } catch (err) {
        // Rewritten whole at the next save.
        this.error(`${this.cellLog.file} not saved: ${(err as Error).message}`);
      }
    }
    if (!this.dirty) {
      return;
    }
    const saved: Saved = {
      version: 1,
      zoom: store.adjustZoom,
      adjustments: [...store.adjustments],
      ...(this.cellsInState ? { cells: [...cells.values()] } : {}),
      ...(this.legacy.length > 0 ? { samples: this.legacy } : {})
    };
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify(saved), tmp);
      this.dirty = false;
    } catch (err) {
      fs.rmSync(tmp, { force: true, recursive: true });
      this.error(`${this.file} not saved: ${(err as Error).message}`);
    }
  }

  /**
   * Restores the saved cells, adjustments and soundings; anything malformed is skipped, so a bad
   * file never stops the plugin. A file that does not load whole is moved aside first, so a
   * later save cannot overwrite what was skipped.
   */
  load(store: NodeStore, posteriors: Posteriors): void {
    const logged = this.loadCellLog(store.adjustZoom);
    this.loadLog(this.loadState(store, posteriors, logged));
  }

  /** Reads `cells.ndjson`: its cells at zoom `z`, by key. */
  private loadCellLog(z: number): Map<number, CellPosterior> {
    const log = this.cellLog;
    let read: CellLogRead | undefined;
    try {
      read = log.read(z);
    } catch (err) {
      this.setAsideCellLog(`is not readable, starting empty: ${(err as Error).message}`);
    }
    if (read && read.malformed > 0) {
      this.setAsideCellLog(`had ${read.malformed} malformed lines, skipped`);
    } else if (read?.otherZoom) {
      const { zoom, count } = read.otherZoom;
      this.setAsideCellLog(
        `was saved at zoom ${zoom}: its ${count} cells are dropped and their ` +
          `adjustments moved onto zoom ${z}`
      );
    }
    if (read?.torn) {
      this.error(`${log.file}: skipped a truncated last line`);
    }
    // A log that is never written: the cells are saved in livechart.json instead.
    this.cellsInState ||= log.keep;
    return read?.cells ?? new Map();
  }

  /**
   * Restores `livechart.json` and the cells `logged`; returns the soundings a version that kept
   * them there saved.
   */
  private loadState(
    store: NodeStore,
    posteriors: Posteriors,
    logged: Map<number, CellPosterior>
  ): Sounding[] {
    const z = store.adjustZoom;
    const state = this.readState(z);
    if (!state) {
      // Written at the first save, so the zoom is on record.
      this.dirty = true;
      restoreCells([...logged.values()], store, posteriors);
      return [];
    }
    const { saved, from } = state;
    const cells = listOf(saved.cells);
    const samples = listOf(saved.samples);
    const notLists = [saved.cells, saved.adjustments, saved.samples].filter(
      (v) => v !== undefined && !Array.isArray(v)
    ).length;
    const merged = mergeCells(logged, cells, z);
    const malformed =
      notLists +
      cells.filter((c) => !isCell(c)).length +
      restoreCells([...merged.values()], store, posteriors) +
      restoreAdjustments(saved.adjustments, from, store, posteriors) +
      samples.filter((v) => !isSounding(v)).length;
    if (cells.some(isCell)) {
      // They stay in livechart.json until cells.ndjson has been rewritten with them.
      this.cellsInState = true;
      this.cellLog.rewrite = true;
      this.dirty = true;
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
      this.error(`${log.file}: skipped a truncated last line`);
    }
    const logged = read?.samples ?? [];
    const first = logged[0]?.at ?? Infinity;
    this.legacy = legacy.filter((s) => s.at < first);
    log.samples = [...this.legacy, ...logged].slice(-this.maxSamples);
    log.rewrite ||= legacy.length > 0;
  }

  /** The saved state file and the zoom it is at, or undefined with the reason reported. */
  private readState(z: number): { saved: Record<string, unknown>; from: number } | undefined {
    const saved = this.readSaved();
    if (!saved) {
      return undefined;
    }
    const from = savedZoom(saved, z);
    if (from === undefined || z - from > MAX_ZOOM_STEPS) {
      this.setAside(`has zoom ${String(saved.zoom)}, which cannot be mapped onto zoom ${z}`);
      return undefined;
    }
    return { saved, from };
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
    this.keepFile ||= !moveAside(this.file, reason, this.error);
  }

  /** Sets the sounding log aside to be rewritten; if that fails, never writes it. */
  private setAsideLog(reason: string): void {
    const moved = moveAside(this.log.file, reason, this.error);
    this.log.keep ||= !moved;
    this.log.rewrite ||= moved;
  }

  /** Sets the cell log aside to be rewritten; if that fails, never writes it. */
  private setAsideCellLog(reason: string): void {
    const moved = moveAside(this.cellLog.file, reason, this.error);
    this.cellLog.keep ||= !moved;
    this.cellLog.rewrite ||= moved;
  }
}

/**
 * The cells of `cells.ndjson` with those of `livechart.json` at zoom `z`: for a cell in both,
 * the copy with more samples, the state file's on a tie, whichever file a cut left newer.
 */
function mergeCells(
  logged: ReadonlyMap<number, CellPosterior>,
  cells: readonly unknown[],
  z: number
): Map<number, CellPosterior> {
  const merged = new Map(logged);
  for (const c of cells) {
    if (isCell(c) && c.z === z) {
      const key = tileKey(c.z, c.x, c.y);
      const other = merged.get(key);
      if (!other || c.samples >= other.samples) {
        merged.set(key, c);
      }
    }
  }
  return merged;
}
