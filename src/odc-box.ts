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
}

/** The tiles staged for one build: the job writing them, how many, and the charts' key. */
export interface OdcStage {
  key?: string;
  job?: OdcCellJob;
  count?: number;
}

export class OdcBox {
  constructor(
    private readonly dir: string,
    private readonly source: OdcSource | undefined
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

  /** Whether the charts meeting the box differ from those it was built with. */
  changed(box: Bbox, record: OdcRecord): boolean {
    return this.source !== undefined && this.source.tiles.key(box) !== record.odc;
  }

  /** Stages the tiles of `bbox` for the build process; no job when no chart covers the box. */
  async stage(bbox: Bbox, now: number, signal: AbortSignal): Promise<OdcStage> {
    const key = this.source?.tiles.key(bbox);
    if (!this.source || key === undefined) {
      return {};
    }
    const tiles = path.join(this.dir, "odc-tiles.bin");
    const count = await this.source.tiles.stage(bbox, tiles, signal);
    if (count === 0) {
      fs.rmSync(tiles, { force: true });
      return { key };
    }
    const job: OdcCellJob = {
      tiles,
      dir: this.cellDir,
      bbox,
      now: new Date(now).toISOString(),
      catzoc: this.source.catzoc
    };
    return { key, job, count };
  }

  /** What the box built with `stage` records. */
  static record(stage: OdcStage): OdcRecord {
    return {
      ...(stage.key === undefined ? {} : { odc: stage.key }),
      ...(stage.count === undefined ? {} : { odcTiles: stage.count })
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
