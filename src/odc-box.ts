import fs from "fs";
import path from "path";
import type { OdcTiles } from "./charts-provider-tiles";
import { readCellInfo } from "./ingest/cell-reader";
import type { OdcCellJob, OdcCounts } from "./ingest/odc";
import { ODC_CELL_NAME } from "./ingest/odc";
import type { Bbox } from "./ingest/wfs";
import { isAlive } from "./spatial/chart-index";
import { spoken } from "./engine/chart-box";

/**
 * The Open Data Charts cell of the box around the vessel (`ingest/odc.ts`): which charts meet
 * a box, the tiles staged for its build process, and the cell a start finds saved.
 */

/** Open Data Charts depths for the box, with the CATZOC assumed for them. */
export interface OdcSource {
  tiles: OdcTiles;
  catzoc: number;
}

/** What the box records of its Open Data Charts cell (`WfsBox`). */
export interface OdcRecord {
  /** The charts meeting it when it was built (`OdcTiles.key`). */
  odc?: string;
  /** How many tiles its cell holds; absent when it has no such cell. */
  odcTiles?: number;
  /** The CATZOC assumed for them, with `odc`. */
  odcCatzoc?: number;
}

/** The tiles staged for one build: the job writing them, how many, and the charts' key. */
export interface OdcStage {
  key?: string;
  job?: OdcCellJob;
  count?: number;
  catzoc?: number;
  /** Why the tiles could not be read: the box is built without them. */
  failed?: string;
}

/**
 * After a failed read the box is built without the charts, and read again this long after it
 * is handed over, ms; doubled after each failure in a row, up to MAX_RETRY_MS.
 */
const RETRY_MS = 300_000;
const MAX_RETRY_MS = 3_600_000;
/** A staging file's name: the process that wrote it, and its build. */
const STAGING = /^odc-tiles-(\d+)-\d+\.bin$/;

let staged = 0;

export class OdcBox {
  /** Until when a box built without the charts after a failed read stays as it is. */
  private retryAt = -Infinity;
  /** Failed reads in a row. */
  private failures = 0;
  /** What went wrong with the last read, for the status; none after a clean one. */
  private problem?: string;

  constructor(
    private readonly dir: string,
    private readonly source: OdcSource | undefined,
    private readonly error: (message: string) => void = () => undefined,
    private readonly clock: () => number = Date.now
  ) {}

  get cellDir(): string {
    return path.join(this.dir, ODC_CELL_NAME);
  }

  /**
   * The saved cell, when the box was built with one and it still reads; `lost` when it should
   * be there and is not, as after a power cut, so the box is built again at the first check.
   */
  saved(box: OdcRecord | undefined): { dir?: string; lost: boolean } {
    if (box?.odcTiles === undefined || !this.source) {
      return { lost: false };
    }
    try {
      if (fs.existsSync(this.cellDir)) {
        readCellInfo(this.cellDir);
        return { dir: this.cellDir, lost: false };
      }
    } catch {
      // Torn: read again from the tiles.
    }
    return { lost: true };
  }

  /**
   * Whether the charts meeting the box, or the quality assumed for them, differ from those it
   * was built with; after a failed read, only once the retry wait is over. While the charts
   * cannot be known (Charts Provider not started yet, or its list unreadable) the box stays.
   */
  changed(box: Bbox, record: OdcRecord, now: number): boolean {
    const key = this.source?.tiles.key(box);
    if (!this.source || key === undefined) {
      return false;
    }
    const charts = key ?? undefined;
    if (charts !== record.odc) {
      return record.odc !== undefined || now >= this.retryAt;
    }
    return charts !== undefined && record.odcCatzoc !== this.source.catzoc;
  }

  /** What the status says of the last read, when something went wrong with it. */
  note(now: number): string | undefined {
    if (this.problem === undefined) {
      return undefined;
    }
    const wait = this.retryAt - now;
    return wait > 0 && Number.isFinite(wait)
      ? `${this.problem} (read again in ${spoken(wait)})`
      : this.problem;
  }

  /**
   * Stages the tiles of `bbox` for the build process; no job when no chart covers the box or
   * every read came back empty. A failed read stages none and leaves the box without the
   * charts, so a provider that fails never holds up the ENC and WFS depths.
   */
  async stage(bbox: Bbox, now: number, signal: AbortSignal): Promise<OdcStage> {
    const key = this.source?.tiles.key(bbox);
    if (!this.source || key === null) {
      return {};
    }
    this.removeStale();
    // Its own name, so an aborted build's cleanup cannot remove the next build's tiles.
    const tiles = path.join(this.dir, `odc-tiles-${process.pid}-${++staged}.bin`);
    let count: number;
    try {
      count = await this.source.tiles.stage(bbox, tiles, signal);
    } catch (err) {
      fs.rmSync(tiles, { force: true });
      if (signal.aborted) {
        throw err;
      }
      const failed = (err as Error).message;
      this.problem = `Open Data Charts not read: ${failed}`;
      this.error(this.problem);
      return { failed };
    }
    const catzoc = this.source.catzoc;
    if (count === 0) {
      fs.rmSync(tiles, { force: true });
      // No chart known when staging began: nothing to record.
      return key === undefined ? {} : { key, catzoc };
    }
    const job: OdcCellJob = {
      tiles,
      dir: this.cellDir,
      bbox,
      now: new Date(now).toISOString(),
      catzoc
    };
    return { key: key ?? this.source.tiles.key(bbox) ?? undefined, job, count, catzoc };
  }

  /**
   * Removes the staging files of processes that no longer run. This process's own and those of
   * a live process are left alone, as a build, aborted or not, may still be reading one: the
   * data directory is not known to belong to one server process.
   */
  private removeStale(): void {
    for (const name of fs.readdirSync(this.dir)) {
      const pid = Number(STAGING.exec(name)?.[1]);
      if (Number.isInteger(pid) && pid !== process.pid && !isAlive(pid)) {
        fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
  }

  /**
   * What the box built with `stage` records, once built; `read` is what the build process made
   * of the tiles. After a failed read the box records no charts and waits before reading them
   * again, from now, since a build takes minutes: longer after each failure in a row.
   */
  built(stage: OdcStage, read: OdcCounts | undefined): OdcRecord {
    // A cell the build process could not write, or with no tile that decoded, holds nothing.
    const failed = stage.failed ?? (read?.tiles === 0 ? read.error : undefined);
    if (failed !== undefined) {
      this.failures++;
      const wait = Math.min(RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS);
      this.retryAt = this.clock() + wait;
      this.problem = `Open Data Charts not read: ${failed}`;
      return {};
    }
    this.failures = 0;
    this.retryAt = -Infinity;
    this.problem = read?.skipped
      ? `Open Data Charts: ${read.skipped} tile(s) left out, unreadable: ${read.error}`
      : undefined;
    return {
      ...(stage.key === undefined ? {} : { odc: stage.key }),
      ...(stage.count === undefined ? {} : { odcTiles: stage.count }),
      ...(stage.catzoc === undefined ? {} : { odcCatzoc: stage.catzoc })
    };
  }

  /** Runs `build`, then removes the staged tiles it read, whether it succeeded or not. */
  static async whileStaged<T>(stage: OdcStage, build: () => Promise<T>): Promise<T> {
    try {
      return await build();
    } finally {
      if (stage.job) {
        fs.rmSync(stage.job.tiles, { force: true });
      }
    }
  }
}
