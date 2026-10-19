import fs from "fs";
import path from "path";
import type { PluginConfig } from "./config";
import { readCellDirectory } from "./ingest/cell-reader";
import { WFS_SOURCE } from "./ingest/wfs";
import type { ChartIndex } from "./spatial/chart-index";
import {
  buildChartIndex,
  loadChartIndex,
  recoverChartIndex,
  saveChartIndex,
  savedIndexIsCurrent
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

export function cellDirectories(cellsDir: string | undefined): string[] {
  if (!cellsDir) {
    return [];
  }
  return fs
    .readdirSync(cellsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(cellsDir, e.name))
    .sort();
}

/**
 * `extraDirs` are cells kept by the plugin itself, such as the Traficom WFS
 * box. A saved index that still holds such a cell after the source was
 * turned off is rebuilt without it, and one that lacks it once the source is
 * back on is rebuilt with it.
 */
export function loadOrBuildIndex(
  cfg: PluginConfig,
  dataDir: string,
  extraDirs: string[] = []
): IndexLoad {
  const indexDir = cfg.indexDir ?? path.join(dataDir, "index");
  try {
    const saved = exists(indexDir);
    const { stale, mismatch } = savedMatches(cfg, indexDir, saved, extraDirs);
    const sources = Boolean(cfg.cellsDir) || extraDirs.length > 0;
    if (sources && (cfg.rebuildIndex || mismatch || !saved)) {
      return build(cfg, indexDir, [...cellDirectories(cfg.cellsDir), ...extraDirs]);
    }
    if (stale || !saved) {
      return { indexDir, built: false, reason: missingReason(cfg, indexDir, stale) };
    }
    return { index: loadChartIndex(indexDir), indexDir, built: false };
  } catch (err) {
    return { indexDir, built: false, reason: `chart index failed: ${(err as Error).message}` };
  }
}

function build(cfg: PluginConfig, indexDir: string, dirs: string[]): IndexLoad {
  if (dirs.length === 0) {
    return { indexDir, built: false, reason: `no cells in ${cfg.cellsDir ?? "cellsDir"}` };
  }
  const index = buildChartIndex(
    dirs.map((d, i) => readCellDirectory(d, i)),
    { leafZoom: cfg.leafZoom }
  );
  saveChartIndex(indexDir, index);
  return { index, indexDir, built: true };
}

function missingReason(cfg: PluginConfig, indexDir: string, stale: boolean): string {
  if (stale) {
    return "the saved index holds Traficom WFS depths and that source is off; set cellsDir";
  }
  return cfg.wfs
    ? "waiting for the first Traficom WFS download"
    : `no chart index in ${indexDir}; set cellsDir`;
}

/**
 * `stale`: the saved index holds WFS depths and the source is off. `mismatch`: that, the
 * source is on and the saved index lacks its cell, or the index was built under an older
 * pyramid version. Either way the saved index is not used as is.
 */
function savedMatches(
  cfg: PluginConfig,
  indexDir: string,
  saved: boolean,
  extraDirs: string[]
): { stale: boolean; mismatch: boolean } {
  const holds = saved && holdsWfs(indexDir);
  const stale = holds && !cfg.wfs;
  const outdated = saved && !savedIndexIsCurrent(indexDir);
  return { stale, mismatch: stale || outdated || (saved && extraDirs.length > 0 && !holds) };
}

function holdsWfs(indexDir: string): boolean {
  const raw = JSON.parse(fs.readFileSync(path.join(indexDir, "cells.json"), "utf8")) as {
    cells?: { source?: unknown }[];
  };
  return (raw.cells ?? []).some((c) => c.source === WFS_SOURCE);
}
