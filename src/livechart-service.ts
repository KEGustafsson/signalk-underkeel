import type { ServerAPI } from "@signalk/server-api";
import fs from "fs";
import path from "path";
import type { CsbPlatform } from "./livechart/csb-export";
import { csbGeoJson } from "./livechart/csb-export";
import type { Discrepancy } from "./livechart/discrepancy";
import { discrepancyOf, noteFor, noteId } from "./livechart/discrepancy";
import type { CellPosterior } from "./livechart/posterior";
import {
  adjustmentFor,
  chartPrior,
  isDiscrepancy,
  Posteriors,
  rebasePrior
} from "./livechart/posterior";
import {
  isCell,
  isNodeValues,
  isRecord,
  isSounding,
  listOf,
  mergeAdjustments,
  tilesAt
} from "./livechart/saved-state";
import type { RawSounding, Sounding, SoundingSource } from "./livechart/soundings";
import { reduce } from "./livechart/soundings";
import type { NodeStore, NodeValues } from "./spatial/node-store";
import { tileKey } from "./foundation/geo";
import type { PluginConfig } from "./config";
import type { Clock, Monitor } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";

/**
 * Living chart for the plugin (plan §4.13): own soundings update per-cell
 * posteriors; a confirmed discrepancy lowers the cell for every query and
 * becomes a Signal K note. State is kept in `livechart.json` beside the
 * index. Nothing here can make a cell deeper (safety invariant 5).
 */

export interface LivechartConfig {
  source: SoundingSource;
  writeNotes: boolean;
  csb: Omit<CsbPlatform, "transducerDepth">;
}

export interface LivechartDeps {
  setNote(id: string, body: Record<string, unknown>): Promise<void>;
  error(message: string): void;
}

/** Soundings kept for the CSB export, newest last. */
const MAX_SAMPLES = 20000;

interface Saved {
  version: 1;
  /** The living-chart zoom the cells and adjustment keys are at. */
  zoom: number;
  cells: CellPosterior[];
  adjustments: [number, NodeValues][];
  samples: Sounding[];
}

export class LivechartService {
  private readonly posteriors: Posteriors;
  private samples: Sounding[] = [];
  private dirty = false;
  readonly rejected = new Map<string, number>();
  accepted = 0;
  /** Set when a state file that did not load whole could not be moved aside: never overwrite it. */
  private keepFile = false;

  constructor(
    private store: NodeStore,
    private readonly config: LivechartConfig,
    private readonly file: string,
    private readonly deps: LivechartDeps
  ) {
    this.posteriors = new Posteriors(store);
    this.load();
  }

  /**
   * Moves the living chart onto a rebuilt index with the same leaf zoom, as load() does for
   * a saved state: each cell is rebased onto the new chart prior and judged again.
   */
  rebind(store: NodeStore): void {
    for (const [key, c] of this.posteriors.cells) {
      this.posteriors.cells.set(key, rebasePrior(c, chartPrior(store, c.z, c.x, c.y)));
    }
    const z = this.store.adjustZoom;
    for (const [key, v] of this.store.adjustments) {
      store.adjustments.set(key, { ...v, cellRef: this.cellRefAt(store, z, key) });
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
    this.samples.push(r.sounding);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
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
    if (this.config.writeNotes) {
      this.deps
        .setNote(noteId(c), noteFor(discrepancyOf(c)))
        .catch((err: Error) => this.deps.error(`note ${noteId(c)}: ${err.message}`));
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
    return csbGeoJson(this.samples, {
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
   * Writes `livechart.json` when anything changed, atomically. A failed write
   * is reported, not thrown: it runs from plugin stop and from the delta
   * handler. The state stays dirty, so the next save tries again.
   */
  save(): void {
    if (!this.dirty || this.keepFile) {
      return;
    }
    const saved: Saved = {
      version: 1,
      zoom: this.store.adjustZoom,
      cells: [...this.posteriors.cells.values()],
      adjustments: [...this.store.adjustments],
      samples: this.samples
    };
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(saved));
      fs.renameSync(tmp, this.file);
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
    const saved = this.readSaved();
    if (!saved) {
      return;
    }
    const z = this.store.adjustZoom;
    const from = savedZoom(saved, z);
    if (from === undefined || z - from > MAX_ZOOM_STEPS) {
      this.setAside(`has zoom ${String(saved.zoom)}, which cannot be mapped onto zoom ${z}`);
      return;
    }
    const cells = listOf(saved.cells);
    const samples = listOf(saved.samples);
    const notLists = [saved.cells, saved.adjustments, saved.samples].filter(
      (v) => v !== undefined && !Array.isArray(v)
    ).length;
    const malformed =
      notLists +
      this.restoreCells(cells) +
      this.restoreAdjustments(saved.adjustments, from) +
      samples.filter((v) => !isSounding(v)).length;
    // Against a rebuilt chart a cell may qualify that did not before; adjust() only lowers.
    for (const c of this.posteriors.cells.values()) {
      if (isDiscrepancy(c)) {
        this.adjust(c);
      }
    }
    this.samples = samples.filter(isSounding).slice(-MAX_SAMPLES);
    // What did load is written to a new file at the next save; the old one is set aside.
    this.dirty ||= malformed > 0 || from !== z;
    if (malformed > 0) {
      this.setAside(`had ${malformed} malformed entries, skipped`);
    } else if (from !== z && cells.length > 0) {
      this.setAside(
        `was saved at zoom ${from}: its ${cells.length} cells are dropped and their ` +
          `adjustments moved onto zoom ${z}`
      );
    }
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

  /** Renames the state file to `.bad-<ms>` and reports why; if that fails, never writes it. */
  private setAside(reason: string): void {
    const aside = `${this.file}.bad-${Date.now()}`;
    try {
      fs.renameSync(this.file, aside);
      this.deps.error(`${this.file} ${reason}; moved to ${aside}`);
    } catch (err) {
      this.keepFile = true;
      this.deps.error(
        `${this.file} ${reason}; not moved aside (${(err as Error).message}), so not saved over`
      );
    }
  }

  /**
   * Restores the cells at the current living-chart zoom and returns how many were malformed.
   * Cells at another zoom are keyed at that zoom and dropped; their adjustments are mapped.
   * The index may have been rebuilt since the save, so each cell is moved onto the current
   * chart's prior and cell reference; a saved cellRef indexes the catalogue it was saved with.
   */
  private restoreCells(cells: unknown[]): number {
    const z = this.store.adjustZoom;
    let malformed = 0;
    for (const c of cells) {
      if (!isCell(c)) {
        malformed++;
      } else if (c.z === z) {
        // An uncharted cell's NaN prior is saved as null.
        const chartDepth = typeof c.chartDepth === "number" ? c.chartDepth : NaN;
        const current = chartPrior(this.store, c.z, c.x, c.y);
        this.posteriors.cells.set(
          tileKey(c.z, c.x, c.y),
          rebasePrior({ ...c, chartDepth }, current)
        );
      }
    }
    return malformed;
  }

  /**
   * Restores saved adjustments at the current zoom and returns how many were malformed. They
   * keep their depths, since they only ever lower a cell: onto a coarser zoom a cell takes the
   * shallowest depth and largest σ of the saved cells in it, onto a finer one every cell inside
   * a saved one takes its values.
   */
  private restoreAdjustments(adjustments: unknown, from: number): number {
    const z = this.store.adjustZoom;
    let malformed = 0;
    for (const entry of listOf(adjustments)) {
      const [key, v] = Array.isArray(entry) ? (entry as unknown[]) : [];
      const valid =
        Number.isSafeInteger(key) && (key as number) >= 0 && (key as number) < 4 ** from;
      if (!(valid && isNodeValues(v))) {
        malformed++;
        continue;
      }
      for (const t of tilesAt(key as number, from, z)) {
        const k = tileKey(z, t.x, t.y);
        const next = { ...v, cellRef: this.cellRefAt(this.store, z, k) };
        this.store.adjustments.set(k, mergeAdjustments(this.store.adjustments.get(k), next));
      }
    }
    return malformed;
  }

  /** The current chart's cell reference for living-chart cell `key`. */
  private cellRefAt(store: NodeStore, z: number, key: number): number {
    const n = 2 ** z;
    return (
      this.posteriors.cells.get(key)?.cellRef ??
      chartPrior(store, z, Math.floor(key / n), key % n).cellRef
    );
  }
}

/**
 * A saved cell is copied onto 4^steps finer cells; leaf zooms 14–22 give living-chart zooms
 * 14–18, so a real change is at most 4 steps.
 */
const MAX_ZOOM_STEPS = 4;

/** The zoom a saved state's cells and keys are at: as saved, else that of its cells. */
function savedZoom(saved: Record<string, unknown>, current: number): number | undefined {
  const z =
    saved.zoom !== undefined ? saved.zoom : (listOf(saved.cells).find(isCell)?.z ?? current);
  return Number.isInteger(z) && (z as number) >= 0 && (z as number) <= 26
    ? (z as number)
    : undefined;
}

/** The living chart is written to disk at most this often while soundings arrive. */
const SAVE_EVERY_MS = 60_000;

/** Creates the service when the living chart is on and feeds it the monitor's soundings. */
export function startLivechart(
  app: Pick<ServerAPI, "getDataDirPath" | "resourcesApi" | "error">,
  clock: Pick<Clock, "now">,
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
      error: (m) => app.error(m)
    }
  );
  let savedAt = clock.now();
  monitor.watch([lc.path], (_p, value, at) => {
    lc.onSounding({
      depth: typeof value === "number" ? value : NaN,
      at,
      ...monitor.fresh(),
      positionAt: monitor.nav.position?.at,
      waterLevel: monitor.waterLevel()
    });
    if (clock.now() - savedAt >= SAVE_EVERY_MS) {
      savedAt = clock.now();
      lc.save();
    }
  });
  return lc;
}
