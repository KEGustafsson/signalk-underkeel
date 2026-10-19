import fs from "fs";
import path from "path";
import type { PluginConfig } from "./config";
import { readCellDirectory, readCellInfo } from "./ingest/cell-reader";
import type { CellInfo } from "./ingest/cells";
import { parseCatalogue, usageBandFromName } from "./ingest/cells";
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
 * to, when none exists yet or when the cells changed since it was saved,
 * otherwise loads the saved one. Failure is reported as a reason, so the
 * engine can publish `off` with it.
 */

export interface IndexLoad {
  index?: ChartIndex;
  /** Where the index lives or would live. */
  indexDir: string;
  /** Why there is no index, or with an index, why it was rebuilt and what was skipped. */
  reason?: string;
  built: boolean;
}

/** A saved index is present, after recovering one a crash during save left moved aside. */
function exists(dir: string): boolean {
  recoverChartIndex(dir);
  return fs.existsSync(path.join(dir, "pyramid.bin"));
}

interface CellScan {
  dirs: string[];
  /** Entries named like a cell that are not a directory or a link to one. */
  skipped: string[];
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A dangling link or a file such as `FI5ABCDE.000` is most likely a cell the user expects read. */
function looksLikeCell(e: fs.Dirent): boolean {
  return e.isSymbolicLink() || (!e.name.startsWith(".") && usageBandFromName(e.name) !== undefined);
}

function scanCells(cellsDir: string | undefined): CellScan {
  const scan: CellScan = { dirs: [], skipped: [] };
  if (!cellsDir) {
    return scan;
  }
  for (const e of fs.readdirSync(cellsDir, { withFileTypes: true })) {
    const full = path.join(cellsDir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && isDirectory(full))) {
      scan.dirs.push(full);
    } else if (looksLikeCell(e)) {
      scan.skipped.push(e.name);
    }
  }
  scan.dirs.sort();
  scan.skipped.sort();
  return scan;
}

export function cellDirectories(cellsDir: string | undefined): string[] {
  return scanCells(cellsDir).dirs;
}

function skippedNote(cellsDir: string | undefined, scan: CellScan): string[] {
  return scan.skipped.length === 0
    ? []
    : [
        `skipped ${scan.skipped.join(", ")} in ${cellsDir ?? "cellsDir"}: not a cell directory; ` +
          "export each .000 with scripts/enc-to-geojson.sh"
      ];
}

/** Several notes become one reason; a failure reason comes first. */
function withNotes(load: IndexLoad, notes: string[]): IndexLoad {
  const reason = [load.reason, ...notes].filter((r) => r !== undefined).join("; ");
  return reason === "" ? load : { ...load, reason };
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
    return loadOrBuild(cfg, indexDir, extraDirs);
  } catch (err) {
    return { indexDir, built: false, reason: `chart index failed: ${(err as Error).message}` };
  }
}

function loadOrBuild(cfg: PluginConfig, indexDir: string, extraDirs: string[]): IndexLoad {
  const saved = exists(indexDir) ? savedCells(indexDir) : undefined;
  const { stale, mismatch } = savedMatches(cfg, indexDir, saved, extraDirs);
  // An unmounted or moved cells directory says nothing about the saved index's cells.
  if (saved && cfg.cellsDir && !fs.existsSync(cfg.cellsDir)) {
    return loadSaved(cfg, indexDir, stale, [`${cfg.cellsDir} not found; using the saved index`]);
  }
  const scan = scanCells(cfg.cellsDir);
  const change = cellsChange(cfg.cellsDir, saved, scan.dirs);
  const notes = [...(change ? [change] : []), ...skippedNote(cfg.cellsDir, scan)];
  const sources = Boolean(cfg.cellsDir) || extraDirs.length > 0;
  if (sources && (cfg.rebuildIndex || mismatch || !saved || change)) {
    return withNotes(build(cfg, indexDir, [...scan.dirs, ...extraDirs]), notes);
  }
  if (!saved) {
    return { indexDir, built: false, reason: missingReason(cfg, indexDir, false) };
  }
  return loadSaved(cfg, indexDir, stale, notes);
}

function loadSaved(
  cfg: PluginConfig,
  indexDir: string,
  stale: boolean,
  notes: string[]
): IndexLoad {
  if (stale) {
    return { indexDir, built: false, reason: missingReason(cfg, indexDir, true) };
  }
  return withNotes({ index: loadChartIndex(indexDir), indexDir, built: false }, notes);
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
  saved: readonly CellInfo[] | undefined,
  extraDirs: string[]
): { stale: boolean; mismatch: boolean } {
  const holds = saved?.some((c) => c.source === WFS_SOURCE) ?? false;
  const stale = holds && !cfg.wfs;
  const outdated = saved !== undefined && !savedIndexIsCurrent(indexDir);
  return {
    stale,
    mismatch: stale || outdated || (saved !== undefined && extraDirs.length > 0 && !holds)
  };
}

function savedCells(indexDir: string): CellInfo[] {
  return parseCatalogue(JSON.parse(fs.readFileSync(path.join(indexDir, "cells.json"), "utf8")))
    .cells;
}

const cellKey = (c: Pick<CellInfo, "name" | "edition" | "update" | "datumAreas">): string =>
  `${c.name} edition ${c.edition} update ${c.update}` +
  (c.datumAreas ? ` datum areas ${c.datumAreas.join(",")}` : "");

/**
 * Why the saved index no longer matches the cells directory, from each
 * cell's DSID and datum areas, or undefined when it does. A new edition or update, or a
 * cell added or removed, changes which depths and hazards the index holds.
 */
function cellsChange(
  cellsDir: string | undefined,
  saved: readonly CellInfo[] | undefined,
  dirs: string[]
): string | undefined {
  if (!cellsDir || !saved) {
    return undefined;
  }
  const was = saved
    .filter((c) => c.source !== WFS_SOURCE)
    .map(cellKey)
    .sort();
  const now = dirs.map((d) => cellKey(readCellInfo(d))).sort();
  if (was.join("\n") === now.join("\n")) {
    return undefined;
  }
  const added = now.filter((k) => !was.includes(k));
  const removed = was.filter((k) => !now.includes(k));
  const what = [
    ...(added.length > 0 ? [`added ${added.join(", ")}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(", ")}`] : [])
  ];
  return `rebuilt the index: cells in ${cellsDir} changed since it was saved (${
    what.join("; ") || "a cell appears twice"
  })`;
}
