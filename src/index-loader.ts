import fs from "fs";
import path from "path";
import type { PluginConfig } from "./config";
import type { CellInfo } from "./ingest/cells";
import { parseCatalogue } from "./ingest/cells";
import type { CellScan } from "./ingest/cell-source";
import { currentInfo, readCell, scanCellSources } from "./ingest/cell-source";
import { WFS_CELL_NAME, WFS_SOURCE } from "./ingest/wfs";
import { readBox } from "./spatial/build-box";
import type { BuildBox } from "./spatial/build-box";
import type { BuildJob } from "./spatial/build-worker";
import type { ChartIndex } from "./spatial/chart-index";
import {
  buildChartIndex,
  indexDirProblem,
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

/**
 * Whether finding `found` in `cellsDir` means its drive is most likely unmounted rather than
 * emptied: no S-57 cell is left, but `cells`, the catalogue of an index in use or saved, holds
 * some. A mount point stays as an empty directory, and taking it at face value would replace
 * an index of charted hazards with WFS depths alone, or with none.
 */
export function cellsMissing(
  cellsDir: string | undefined,
  found: readonly string[],
  cells: readonly Pick<CellInfo, "source">[] | undefined
): boolean {
  return (
    Boolean(cellsDir) &&
    found.length === 0 &&
    (cells?.some((c) => c.source !== WFS_SOURCE) ?? false)
  );
}

/** The catalogue saved in `indexDir`, or undefined when there is none or it cannot be read. */
export function savedCatalogue(indexDir: string): CellInfo[] | undefined {
  try {
    return savedCells(indexDir);
  } catch {
    return undefined;
  }
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

/**
 * The cells directory's scan or, with an index saved, why the directory says nothing about
 * that index's cells: it is gone, as an unmounted or moved drive leaves it, or it holds none
 * of them while the saved index holds S-57 cells (`cellsMissing`).
 */
function scanCells(
  cellsDir: string | undefined,
  saved: readonly CellInfo[] | undefined
): { scan: CellScan } | { away: string } {
  if (saved && cellsDir && !fs.existsSync(cellsDir)) {
    return { away: `${cellsDir} not found` };
  }
  const scan = scanCellSources(cellsDir);
  return cellsMissing(cellsDir, scan.sources, saved)
    ? { away: `no S-57 cell found in ${cellsDir ?? "cellsDir"}` }
    : { scan };
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
  const found = scanCells(cfg.cellsDir, saved);
  if ("away" in found) {
    return fromSaved([`${found.away}; using the saved index`], (err) => ({
      load: failedLoad(indexDir, err)
    }));
  }
  const { scan } = found;
  // Each cell is stamped once, for the saved catalogue and the saved box alike.
  let stamps: string[] | undefined;
  const encKeys = (): string[] => (stamps ??= scan.sources.map(sourceKey));
  const change = cellsChange(cfg.cellsDir, saved, encKeys);
  const notes = [...(change ? [change] : []), ...skippedNote(cfg.cellsDir, scan)];
  const sources = Boolean(cfg.cellsDir) || extraDirs.length > 0;
  const dirs = [...scan.sources, ...extraDirs];
  const keys = (): string[] => [...encKeys(), ...extraDirs.map(sourceKey)].sort();
  const rebuild = (why: string[]): IndexPlan => buildPlan(cfg, indexDir, dirs, why);
  // A power cut during a save can leave a file empty or short; the cells are read again, in
  // the saved box when the index is built around the vessel.
  const unreadable = (err: unknown): IndexPlan => {
    const why = `the saved one could not be read (${(err as Error).message})`;
    if (!sources) {
      return { load: failedLoad(indexDir, err) };
    }
    return boxed(cfg, sources)
      ? boxUnreadable(cfg, indexDir, dirs, keys, why, skippedNote(cfg.cellsDir, scan))
      : rebuild([`rebuilt the index: ${why}`, ...notes]);
  };
  if (error) {
    return unreadable(error);
  }
  if (boxed(cfg, sources)) {
    return boxPlan(cfg, indexDir, dirs, keys, {
      mismatch,
      fromSaved: (why) => fromSaved(why, unreadable),
      notes: skippedNote(cfg.cellsDir, scan)
    });
  }
  // With no index saved, `mismatch` says so.
  if (sources && (cfg.rebuildIndex || mismatch || change)) {
    return rebuild(notes);
  }
  // An index built in a box is no coverage past it, and boxRadiusKm 0 indexes every cell.
  if (sources && readBox(indexDir)) {
    return rebuild([
      "rebuilt the index: the saved one was built in a box around the vessel",
      ...notes
    ]);
  }
  if (!saved) {
    return { load: { indexDir, built: false, reason: missingReason(cfg, indexDir, false) } };
  }
  return fromSaved(notes, unreadable);
}

/** Whether the index is built around the vessel rather than from every cell. */
const boxed = (cfg: PluginConfig, sources: boolean): boolean => sources && cfg.boxRadiusKm > 0;

const sourceKey = (dir: string): string => cellKey(currentInfo(dir));

/** Each source's stamp, sorted: what a box build records of the cells it chose from. */
export function sourceKeys(dirs: readonly string[]): string[] {
  return dirs.map(sourceKey).sort();
}

/** The Traficom WFS cell's stamp among a box's sources. */
const isWfsKey = (key: string): boolean => key.startsWith(`${WFS_CELL_NAME} edition `);

const boxWaiting = (indexDir: string, notes: string[]): IndexPlan => ({
  load: withNotes({ indexDir, built: false, reason: BOX_WAITING_REASON }, notes)
});

/** A box index that could not be read: rebuilt in its saved box, or with none, nothing yet. */
function boxUnreadable(
  cfg: PluginConfig,
  indexDir: string,
  dirs: string[],
  keys: () => string[],
  why: string,
  notes: string[]
): IndexPlan {
  const box = readBox(indexDir);
  return box
    ? buildPlan(cfg, indexDir, dirs, [`rebuilt the index: ${why}`, ...notes], {
        bbox: box.bbox,
        sources: keys()
      })
    : boxWaiting(indexDir, [`not using the saved index: ${why}`, ...notes]);
}

/**
 * The plan when the index is built around the vessel: the saved index while
 * it was built in a box from the same cells, else a build in that box; with
 * no saved box nothing until the box service has a position (invariant 3).
 * `mismatch` says why the saved index cannot be used whatever its box.
 */
function boxPlan(
  cfg: PluginConfig,
  indexDir: string,
  dirs: string[],
  keys: () => string[],
  p: {
    mismatch: string | undefined;
    fromSaved: (notes: string[]) => IndexPlan;
    notes: string[];
  }
): IndexPlan {
  const box = readBox(indexDir);
  if (!box) {
    return boxWaiting(indexDir, p.notes);
  }
  const sources = keys();
  // A WFS cell left out of the start, torn or gone, is downloaded again by the box service;
  // the saved index still holds its depths meanwhile.
  const was = sources.some(isWfsKey) ? box.sources : box.sources.filter((k) => !isWfsKey(k));
  const sameCells = sources.join("\n") === was.join("\n");
  const sameZoom = box.leafZoom === cfg.leafZoom;
  if (!p.mismatch && !cfg.rebuildIndex && sameCells && sameZoom) {
    return p.fromSaved(p.notes);
  }
  const why = cfg.rebuildIndex
    ? undefined
    : (p.mismatch ??
      (sameCells
        ? `leaf zoom ${cfg.leafZoom} differs from the saved ${box.leafZoom ?? "?"}`
        : `cells in ${cfg.cellsDir ?? "cellsDir"} changed since it was saved`));
  const notes = [...(why ? [`rebuilt the index: ${why}`] : []), ...p.notes];
  return buildPlan(cfg, indexDir, dirs, notes, { bbox: box.bbox, sources });
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
  notes: string[],
  box?: BuildBox
): IndexPlan {
  if (dirs.length === 0) {
    const none = { indexDir, built: false, reason: `no cells in ${cfg.cellsDir ?? "cellsDir"}` };
    return { load: withNotes(none, notes) };
  }
  // The build would be refused only once it is done: minutes on a Pi 4.
  const refused = indexDirProblem(indexDir);
  if (refused !== undefined) {
    return { load: failedLoad(indexDir, new Error(refused)) };
  }
  const build: BuildJob = { dirs, leafZoom: cfg.leafZoom, indexDir };
  return { build: box ? { ...build, box } : build, indexDir, notes };
}

function missingReason(cfg: PluginConfig, indexDir: string, stale: boolean): string {
  if (stale) {
    return "the saved index holds Traficom WFS depths and that source is off; set cellsDir";
  }
  return cfg.wfs ? WFS_WAITING_REASON : `no chart index in ${indexDir}; set cellsDir`;
}

/**
 * `stale`: the saved index holds WFS depths and the source is off. `mismatch`, why the saved
 * index is not used as is: none is saved, that, the source is on and the saved index lacks
 * its cell, or the index was saved by an older version of its pyramid or hazard file.
 */
function savedMatches(
  cfg: PluginConfig,
  indexDir: string,
  saved: readonly CellInfo[] | undefined,
  extraDirs: string[]
): { stale: boolean; mismatch: string | undefined } {
  const holds = saved?.some((c) => c.source === WFS_SOURCE) ?? false;
  const stale = holds && !cfg.wfs;
  const mismatch =
    saved === undefined
      ? `no index saved in ${indexDir}`
      : stale
        ? "the saved one holds Traficom WFS depths and that source is off"
        : !savedIndexIsCurrent(indexDir)
          ? "the saved one is from an older index version or its header is damaged"
          : extraDirs.length > 0 && !holds
            ? "the saved one lacks the Traficom WFS cell"
            : undefined;
  return { stale, mismatch };
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
  keys: () => string[]
): string | undefined {
  if (!cellsDir || !saved) {
    return undefined;
  }
  const was = saved
    .filter((c) => c.source !== WFS_SOURCE)
    .map(cellKey)
    .sort();
  const now = [...keys()].sort();
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
