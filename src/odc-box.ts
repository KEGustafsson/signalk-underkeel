import fs from "fs";
import path from "path";
import type { OdcTiles } from "./charts-provider-tiles";
import { readCellInfo } from "./ingest/cell-reader";
import type { OdcCellJob } from "./ingest/odc";
import { ODC_CELL_NAME } from "./ingest/odc";
import type { Bbox } from "./ingest/wfs";

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
}

/** After a failed read the box is built without the charts, and read again after this, ms. */
const RETRY_MS = 300_000;
/** Staging files a crash left behind are removed once this old, ms. */
const STALE_STAGING_MS = 3_600_000;
const STAGING = /^odc-tiles-.*\.bin$/;

let staged = 0;

export class OdcBox {
  /** Until when a box built without the charts after a failed read stays as it is. */
  private retryAt = -Infinity;

  constructor(
    private readonly dir: string,
    private readonly source: OdcSource | undefined,
    private readonly error: (message: string) => void = () => undefined
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
   * was built with; after a failed read, only once the retry wait is over.
   */
  changed(box: Bbox, record: OdcRecord, now: number): boolean {
    if (!this.source) {
      return false;
    }
    const key = this.source.tiles.key(box);
    if (key !== record.odc) {
      return record.odc !== undefined || now >= this.retryAt;
    }
    return key !== undefined && record.odcCatzoc !== this.source.catzoc;
  }

  /**
   * Stages the tiles of `bbox` for the build process; no job when no chart covers the box or
   * every read came back empty. A failed read stages none and leaves the box without the
   * charts, so a provider that fails never holds up the ENC and WFS depths.
   */
  async stage(bbox: Bbox, now: number, signal: AbortSignal): Promise<OdcStage> {
    const key = this.source?.tiles.key(bbox);
    if (!this.source || key === undefined) {
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
      this.retryAt = now + RETRY_MS;
      this.error(`Open Data Charts tiles not read: ${(err as Error).message}`);
      return {};
    }
    const catzoc = this.source.catzoc;
    if (count === 0) {
      fs.rmSync(tiles, { force: true });
      return { key, catzoc };
    }
    const job: OdcCellJob = {
      tiles,
      dir: this.cellDir,
      bbox,
      now: new Date(now).toISOString(),
      catzoc
    };
    return { key, job, count, catzoc };
  }

  /** File times are the system clock's, so they are compared with it. */
  private removeStale(): void {
    const now = Date.now();
    for (const name of fs.readdirSync(this.dir).filter((n) => STAGING.test(n))) {
      const file = path.join(this.dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_STAGING_MS) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Removed meanwhile by its own build.
      }
    }
  }

  /** What the box built with `stage` records. */
  static record(stage: OdcStage): OdcRecord {
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
