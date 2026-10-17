import fs from "fs";
import path from "path";
import type { PluginConfig } from "./config";
import { readCellDirectory } from "./ingest/cell-reader";
import type { ChartIndex } from "./spatial/chart-index";
import {
  buildChartIndex,
  loadChartIndex,
  recoverChartIndex,
  saveChartIndex
} from "./spatial/chart-index";

/**
 * Finds the chart index at start: builds it from exported cells when asked
 * to (or when none exists yet), otherwise loads the saved one. Failure is
 * reported as a reason, so the engine can publish `off` with it.
 */

export interface IndexLoad {
  index?: ChartIndex;
  /** Where the index lives or would live. */
  indexDir: string;
  reason?: string;
  built: boolean;
}

/** A saved index is present, after recovering one a crash during save left moved aside. */
function exists(dir: string): boolean {
  recoverChartIndex(dir);
  return fs.existsSync(path.join(dir, "pyramid.bin"));
}

function cellDirectories(cellsDir: string): string[] {
  return fs
    .readdirSync(cellsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(cellsDir, e.name))
    .sort();
}

export function loadOrBuildIndex(cfg: PluginConfig, dataDir: string): IndexLoad {
  const indexDir = cfg.indexDir ?? path.join(dataDir, "index");
  try {
    if (cfg.cellsDir && (cfg.rebuildIndex || !exists(indexDir))) {
      const dirs = cellDirectories(cfg.cellsDir);
      if (dirs.length === 0) {
        return { indexDir, built: false, reason: `no cells in ${cfg.cellsDir}` };
      }
      const index = buildChartIndex(
        dirs.map((d, i) => readCellDirectory(d, i)),
        { leafZoom: cfg.leafZoom }
      );
      saveChartIndex(indexDir, index);
      return { index, indexDir, built: true };
    }
    if (!exists(indexDir)) {
      return { indexDir, built: false, reason: `no chart index in ${indexDir}; set cellsDir` };
    }
    return { index: loadChartIndex(indexDir), indexDir, built: false };
  } catch (err) {
    return { indexDir, built: false, reason: `chart index failed: ${(err as Error).message}` };
  }
}
