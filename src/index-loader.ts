import fs from "fs";
import path from "path";
import type { PluginConfig } from "./config";
import type { CellInfo } from "./ingest/cells";
import { parseCatalogue } from "./ingest/cells";
import type { CellScan } from "./ingest/cell-source";
import { currentInfo, readCell, scanCellSources } from "./ingest/cell-source";
import { WFS_SOURCE } from "./ingest/wfs";
import { readBox } from "./spatial/build-box";
import type { BuildJob } from "./spatial/build-worker";
import type { ChartIndex } from "./spatial/chart-index";
import {
  buildChartIndex,
  loadChartIndex,
  recoverChartIndex,
  saveChartIndex,
  savedIndexIsCurrent
} from "./spatial/chart-index";

/**
 * Finds the chart index at start: builds it from the S-57 cells when asked
 * to, when none exists yet or when the cells changed since it was saved,
 * otherwise loads the saved one. Failure is reported as a reason, so the
 * engine can publish `off` with it. A build is returned as a job, so the
 * plugin runs it in a worker thread instead of blocking the server.
 */

export interface IndexLoad {
  index?: ChartIndex;
  /** Where the index lives or would live. */
  indexDir: string;
  /** Why there is no index, or with an index, why it was rebuilt and what was skipped. */
  reason?: string;
  built: boolean;
}

/** The look-ahead reasons, `off`, while start builds or reads the index (safety invariant 3). */
export const BUILDING_REASON = "building chart index";
export const LOADING_REASON = "loading chart index";
export const WFS_WAITING_REASON = "waiting for the first Traficom WFS download";
export const BOX_WAITING_REASON = "waiting for the vessel position to build the chart box";

/** Reasons that mean the index is on its way, not that loading it failed. */
export const PENDING_REASONS: ReadonlySet<string> = new Set([
  BUILDING_REASON,
  LOADING_REASON,
  WFS_WAITING_REASON,
  BOX_WAITING_REASON
]);

/**
 * A saved pyramid.bin larger than this is read and inflated off the event
 * loop at start; two Nauvo cells (0.56 MB) load in 22 ms on x86, so a file
 * this size blocks about 0.2 s on a Raspberry Pi 4.
 */
export const SYNC_LOAD_BYTES = 1_000_000;

export type BuildPlan = {
  build: BuildJob;
  indexDir: string;
  /** Why it is rebuilt and what was skipped. */
  notes: string[];
};

export type ReadPlan = {
  /** The saved index directory to load, too large to load on the event loop. */
  read: string;
  notes: string[];
  /** What to do instead when the saved index fails to read. */
  unreadable: (err: unknown) => IndexPlan;
};

/** What start does: use `load` as it is, run `build`, or `read` the saved index. */
export type IndexPlan = { load: IndexLoad } | BuildPlan | ReadPlan;

/** A saved index is present, after recovering one a crash during save left moved aside. */
function exists(dir: string): boolean {
  recoverChartIndex(dir);
  return fs.existsSync(path.join(dir, "pyramid.bin"));
}

/** The S-57 base cells (`.000` files) under `cellsDir`, in path order. */
export function cellSources(cellsDir: string | undefined): string[] {
  return scanCellSources(cellsDir).sources;
}

function skippedNote(cellsDir: string | undefined, scan: CellScan): string[] {
  return scan.skipped.length === 0
    ? []
    : [
        `skipped ${scan.skipped.join(", ")} in ${cellsDir ?? "cellsDir"}: ` +
          "no S-57 cell (.000) in it, a dangling link, or a cell name met twice"
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
export function planIndex(
  cfg: PluginConfig,
  dataDir: string,
  extraDirs: string[] = [],
  syncLoadBytes = SYNC_LOAD_BYTES
): IndexPlan {
  const indexDir = cfg.indexDir ?? path.join(dataDir, "index");
  try {
    return plan(cfg, indexDir, extraDirs, syncLoadBytes);
  } catch (err) {
    return { load: failedLoad(indexDir, err) };
  }
}

export const failedLoad = (indexDir: string, err: unknown): IndexLoad => ({
  indexDir,
  built: false,
  reason: `chart index failed: ${(err as Error).message}`
});

/** The index as `planIndex` finds it, with any build or read run here, on the calling thread. */
export function loadOrBuildIndex(
  cfg: PluginConfig,
  dataDir: string,
  extraDirs: string[] = []
): Promise<IndexLoad> {
  return settle(planIndex(cfg, dataDir, extraDirs));
}

async function settle(p: IndexPlan): Promise<IndexLoad> {
  if ("load" in p) {
    return p.load;
  }
  if ("read" in p) {
    try {
      return savedLoad(p, loadChartIndex(p.read));
    } catch (err) {
      return settle(p.unreadable(err));
    }
  }
  try {
    const cells = [];
    for (const [i, d] of p.build.dirs.entries()) {
      cells.push(await readCell(d, i));
    }
    const index = buildChartIndex(cells, { leafZoom: p.build.leafZoom });
    saveChartIndex(p.indexDir, index);
    return builtLoad(p, index);
  } catch (err) {
    return failedLoad(p.indexDir, err);
  }
}

/** The load of an index `p.build` produced. */
export function builtLoad(p: BuildPlan, index: ChartIndex): IndexLoad {
  return withNotes({ index, indexDir: p.indexDir, built: true }, p.notes);
}

/** The load of the index `p.read` names. */
export function savedLoad(p: ReadPlan, index: ChartIndex): IndexLoad {
  return withNotes({ index, indexDir: p.read, built: false }, p.notes);
}

/** The saved catalogue, or why it could not be read; undefined when no index is saved. */
function readSaved(indexDir: string): { cells?: CellInfo[]; error?: Error } {
  if (!exists(indexDir)) {
    return {};
  }
  try {
    return { cells: savedCells(indexDir) };
  } catch (err) {
    return { error: err as Error };
  }
}

function plan(
  cfg: PluginConfig,
  indexDir: string,
  extraDirs: string[],
  syncLoadBytes: number
): IndexPlan {
  const { cells: saved, error } = readSaved(indexDir);
  const { stale, mismatch } = savedMatches(cfg, indexDir, saved, extraDirs);
  const fromSaved = (notes: string[], unreadable: (err: unknown) => IndexPlan): IndexPlan =>
    stale
      ? { load: { indexDir, built: false, reason: missingReason(cfg, indexDir, true) } }
      : savedPlan(indexDir, notes, unreadable, syncLoadBytes);
  // An unmounted or moved cells directory says nothing about the saved index's cells.
  if (saved && cfg.cellsDir && !fs.existsSync(cfg.cellsDir)) {
    return fromSaved([`${cfg.cellsDir} not found; using the saved index`], (err) => ({
      load: failedLoad(indexDir, err)
    }));
  }
  const scan = scanCellSources(cfg.cellsDir);
  const change = cellsChange(cfg.cellsDir, saved, scan.sources);
  const notes = [...(change ? [change] : []), ...skippedNote(cfg.cellsDir, scan)];
  const sources = Boolean(cfg.cellsDir) || extraDirs.length > 0;
  const rebuild = (why: string[]): IndexPlan =>
    buildPlan(cfg, indexDir, [...scan.sources, ...extraDirs], why);
  // A power cut during a save can leave a file empty or short; the cells are read again.
  const unreadable = (err: unknown): IndexPlan =>
    sources
      ? rebuild([
          `rebuilt the index: the saved one could not be read (${(err as Error).message})`,
          ...notes
        ])
      : { load: failedLoad(indexDir, err) };
  if (error) {
    return unreadable(error);
  }
  if (boxed(cfg, sources)) {
    return boxPlan(
      cfg,
      indexDir,
      saved !== undefined && !mismatch,
      [...scan.sources, ...extraDirs],
      {
        fromSaved: (why) => fromSaved(why, unreadable),
        notes: skippedNote(cfg.cellsDir, scan)
      }
    );
  }
  if (sources && (cfg.rebuildIndex || mismatch || !saved || change)) {
    return rebuild(notes);
  }
  if (!saved) {
    return { load: { indexDir, built: false, reason: missingReason(cfg, indexDir, false) } };
  }
  return fromSaved(notes, unreadable);
}

/** Whether the index is built around the vessel rather than from every cell. */
const boxed = (cfg: PluginConfig, sources: boolean): boolean => sources && cfg.boxRadiusKm > 0;

/** Each source's stamp, sorted: what a box build records of the cells it chose from. */
export function sourceKeys(dirs: readonly string[]): string[] {
  return dirs.map((d) => cellKey(currentInfo(d))).sort();
}

/**
 * The plan when the index is built around the vessel: the saved index while
 * it was built in a box from the same cells, else a build in that box; with
 * no saved box nothing until the box service has a position (invariant 3).
 */
function boxPlan(
  cfg: PluginConfig,
  indexDir: string,
  usable: boolean,
  dirs: string[],
  p: { fromSaved: (notes: string[]) => IndexPlan; notes: string[] }
): IndexPlan {
  const box = readBox(indexDir);
  if (!box) {
    return { load: withNotes({ indexDir, built: false, reason: BOX_WAITING_REASON }, p.notes) };
  }
  const keys = sourceKeys(dirs);
  const sameCells = keys.join("\n") === box.sources.join("\n");
  const sameZoom = box.leafZoom === cfg.leafZoom;
  if (usable && !cfg.rebuildIndex && sameCells && sameZoom) {
    return p.fromSaved(p.notes);
  }
  const why = cfg.rebuildIndex
    ? []
    : sameCells
      ? [
          `rebuilt the index: leaf zoom ${cfg.leafZoom} differs from the saved ${box.leafZoom ?? "?"}`
        ]
      : [`rebuilt the index: cells in ${cfg.cellsDir ?? "cellsDir"} changed since it was saved`];
  return {
    build: { dirs, leafZoom: cfg.leafZoom, indexDir, box: { bbox: box.bbox, sources: keys } },
    indexDir,
    notes: [...why, ...p.notes]
  };
}

function savedPlan(
  indexDir: string,
  notes: string[],
  unreadable: (err: unknown) => IndexPlan,
  syncLoadBytes: number
): IndexPlan {
  const p: ReadPlan = { read: indexDir, notes, unreadable };
  if (fs.statSync(path.join(indexDir, "pyramid.bin")).size > syncLoadBytes) {
    return p;
  }
  try {
    return { load: savedLoad(p, loadChartIndex(indexDir)) };
  } catch (err) {
    return unreadable(err);
  }
}

function buildPlan(
  cfg: PluginConfig,
  indexDir: string,
  dirs: string[],
  notes: string[]
): IndexPlan {
  if (dirs.length === 0) {
    const none = { indexDir, built: false, reason: `no cells in ${cfg.cellsDir ?? "cellsDir"}` };
    return { load: withNotes(none, notes) };
  }
  return { build: { dirs, leafZoom: cfg.leafZoom, indexDir }, indexDir, notes };
}

function missingReason(cfg: PluginConfig, indexDir: string, stale: boolean): string {
  if (stale) {
    return "the saved index holds Traficom WFS depths and that source is off; set cellsDir";
  }
  return cfg.wfs ? WFS_WAITING_REASON : `no chart index in ${indexDir}; set cellsDir`;
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

/** An S-57 cell by its files' stamp, a directory by its DSID and datum areas. */
const cellKey = (c: Partial<CellInfo>): string =>
  c.files !== undefined
    ? `${c.name} files ${c.files}`
    : `${c.name} edition ${c.edition} update ${c.update}` +
      (c.datumAreas ? ` datum areas ${c.datumAreas.join(",")}` : "") +
      (c.positionQuality ? " with position quality" : "");

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
  const now = dirs.map((d) => cellKey(currentInfo(d))).sort();
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
