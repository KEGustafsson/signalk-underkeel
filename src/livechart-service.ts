import type { ServerAPI } from "@signalk/server-api";
import fs from "fs";
import path from "path";
import type { CsbPlatform } from "./livechart/csb-export";
import { csbGeoJson } from "./livechart/csb-export";
import type { Discrepancy } from "./livechart/discrepancy";
import { discrepancyOf, noteFor, noteId } from "./livechart/discrepancy";
import type { CellPosterior } from "./livechart/posterior";
import { adjustmentFor, isDiscrepancy, Posteriors } from "./livechart/posterior";
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

  constructor(
    private readonly store: NodeStore,
    private readonly config: LivechartConfig,
    private readonly file: string,
    private readonly deps: LivechartDeps
  ) {
    this.posteriors = new Posteriors(store);
    this.load();
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
    if (!this.dirty) {
      return;
    }
    const saved: Saved = {
      version: 1,
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

  /** Restores saved state; anything malformed is skipped, so a bad file never stops the plugin. */
  private load(): void {
    if (!fs.existsSync(this.file)) {
      return;
    }
    let saved: unknown;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      this.deps.error(
        `${this.file} is not readable JSON, starting empty: ${(err as Error).message}`
      );
      return;
    }
    if (!isRecord(saved)) {
      this.deps.error(`${this.file} is not a living-chart state, starting empty`);
      return;
    }
    if (saved.version !== 1) {
      this.deps.error(`${this.file} has version ${String(saved.version)}, starting empty`);
      return;
    }
    // Cells from an index with another leaf zoom are keyed at another zoom: drop them.
    const z = this.store.adjustZoom;
    for (const c of listOf(saved.cells)) {
      if (isCell(c) && c.z === z) {
        // An uncharted cell's NaN prior is saved as null.
        const chartDepth = typeof c.chartDepth === "number" ? c.chartDepth : NaN;
        this.posteriors.cells.set(tileKey(c.z, c.x, c.y), { ...c, chartDepth });
      }
    }
    for (const entry of listOf(saved.adjustments)) {
      if (Array.isArray(entry) && entry.length === 2) {
        const [key, v] = entry as [unknown, unknown];
        if (typeof key === "number" && this.posteriors.cells.has(key) && isNodeValues(v)) {
          this.store.adjustments.set(key, v);
        }
      }
    }
    this.samples = listOf(saved.samples).filter(isSounding).slice(-MAX_SAMPLES);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const allFinite = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((k) => Number.isFinite(o[k]));

const CELL_NUMBERS = [
  "z",
  "x",
  "y",
  "chartSigma",
  "cellRef",
  "mean",
  "sigma",
  "samples",
  "passes",
  "lastAt"
] as const;

function isCell(v: unknown): v is CellPosterior {
  return (
    isRecord(v) && allFinite(v, CELL_NUMBERS) && Number.isInteger(v.x) && Number.isInteger(v.y)
  );
}

function isNodeValues(v: unknown): v is NodeValues {
  return (
    isRecord(v) &&
    allFinite(v, ["dMin", "sigmaD", "sigmaP", "cellRef"]) &&
    Number.isInteger(v.flags)
  );
}

function isSounding(v: unknown): v is Sounding {
  return (
    isRecord(v) &&
    allFinite(v, ["at", "belowSurface", "depth", "sigma"]) &&
    Array.isArray(v.position) &&
    v.position.length === 2 &&
    v.position.every((n) => Number.isFinite(n))
  );
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
      waterLevel: monitor.waterLevel()
    });
    if (clock.now() - savedAt >= SAVE_EVERY_MS) {
      savedAt = clock.now();
      lc.save();
    }
  });
  return lc;
}
