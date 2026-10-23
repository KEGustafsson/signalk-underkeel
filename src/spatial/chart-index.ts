import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { isMainThread, threadId } from "worker_threads";
import type { ReadCell } from "../ingest/cell-reader";
import type { CellCatalogue } from "../ingest/cells";
import { parseCatalogue } from "../ingest/cells";
import type { ChartFeature, DepthFeature } from "../ingest/features";
import { HazardIndex } from "./hazards";
import type { NodeStore } from "./node-store";
import type { BuildOptions } from "./pyramid-build";
import { buildPyramid } from "./pyramid-build";
import { cacheOf } from "./block-cache";
import type { CacheOptions } from "./block-cache";
import {
  isCurrentPyramid,
  openPyramid,
  openPyramidAsync,
  serializePyramid,
  wholePyramid
} from "./store";

/** The queryable chart: provenance, the min-depth pyramid and the hazard tree. */
export interface ChartIndex {
  catalogue: CellCatalogue;
  pyramid: NodeStore;
  hazards: HazardIndex;
}

/** Object classes kept in the hazard tree so results can name what they hit. */
const HAZARD_CLASSES = new Set(["UWTROC", "WRECKS", "OBSTRN", "SOUNDG"]);

export function isNamedHazard(f: ChartFeature): f is DepthFeature {
  return f.role === "depth" && HAZARD_CLASSES.has(f.objectClass);
}

/**
 * Builds the index from cells read in catalogue order. Every feature of
 * `cells[i]` must carry cellRef i, or each result would name the wrong
 * chart edition; a mismatch is refused.
 */
export function buildChartIndex(cells: ReadCell[], opts: Partial<BuildOptions> = {}): ChartIndex {
  cells.forEach((c, i) => {
    const bad = c.features.find((f) => f.cellRef !== i);
    if (bad) {
      throw new Error(
        `cell ${c.info.name} at index ${i} has a feature with cellRef ${bad.cellRef}`
      );
    }
  });
  const features = cells.flatMap((c) => c.features);
  return {
    catalogue: { version: 1, cells: cells.map((c) => c.info) },
    pyramid: buildPyramid(features, opts),
    hazards: new HazardIndex(features.filter(isNamedHazard))
  };
}

const FILES = { cells: "cells.json", pyramid: "pyramid.bin", hazards: "hazards.json" };

/** JSON has no infinities; land and dry hazards are stored as null. */
interface StoredHazard extends Omit<DepthFeature, "depth"> {
  depth: number | null;
}

/**
 * With delayed allocation a power cut after a rename can leave the renamed
 * directory holding empty files, so each file is on disk before the rename.
 */
function writeDurable(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Makes a rename or a new entry in `dir` survive a power cut. */
function syncDirectory(dir: string): void {
  // Windows cannot open a directory; NTFS journals the rename itself.
  if (process.platform === "win32") {
    return;
  }
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The files an index directory holds: these three, the build's reach and box
 * (`build-reuse.ts`, `build-box.ts`) beside them.
 */
const INDEX_FILES = new Set([...Object.values(FILES), "reach.json", "box.json"]);

/** The first entry of directory `dir` that is not an index file. */
function foreignFile(dir: string): string | undefined {
  return fs.readdirSync(dir).find((name) => !INDEX_FILES.has(name));
}

/**
 * A commit replaces `dir` whole, so one holding anything but an index, such
 * as the charts or the plugin's data set as indexDir by mistake, is refused
 * rather than deleted.
 */
function assertIndexDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(`indexDir ${dir} is not a directory`);
  }
  const foreign = foreignFile(dir);
  if (foreign !== undefined) {
    throw new Error(
      `indexDir ${dir} holds ${foreign}, which is not part of a chart index; ` +
        "a save replaces the whole directory, so set indexDir to an empty or new directory"
    );
  }
}

/**
 * Writes the three index files into a new staging directory beside `dir`
 * and returns its path; `commitChartIndex` swaps it in. A failed write
 * removes the staging.
 */
export function stageChartIndex(dir: string, index: ChartIndex): string {
  // A trailing separator would put the staging inside `dir`, where no commit can move it.
  dir = path.resolve(dir);
  assertIndexDir(dir);
  // A worker thread shares the process id, so the id alone would let a WFS
  // rebuild and a save on the main thread remove each other's directories.
  const suffix = `${process.pid}-${threadId}-${randomBytes(4).toString("hex")}`;
  const staging = `${dir}.tmp-${suffix}`;
  fs.mkdirSync(staging, { recursive: true });
  try {
    writeDurable(path.join(staging, FILES.cells), JSON.stringify(index.catalogue, null, 2));
    writeDurable(path.join(staging, FILES.pyramid), serializePyramid(index.pyramid));
    const hazards: StoredHazard[] = index.hazards.features.map((f) => ({
      ...f,
      depth: Number.isFinite(f.depth) ? f.depth : null
    }));
    writeDurable(path.join(staging, FILES.hazards), JSON.stringify(hazards));
    syncDirectory(staging);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return staging;
}

/**
 * Moves a staged index into `dir` only after all its files are written, so
 * a crash or a full disk never leaves a catalogue from one build beside a
 * pyramid from another. A failed commit removes the staging and leaves the
 * previous index in `dir`; one that is not an index is refused, not replaced.
 */
export function commitChartIndex(dir: string, staging: string): void {
  dir = path.resolve(dir);
  const suffix = /\.tmp-(.+)$/.exec(path.basename(staging))?.[1] ?? randomBytes(4).toString("hex");
  const previous = `${dir}.old-${suffix}`;
  let hadIndex: boolean;
  try {
    assertIndexDir(dir);
    hadIndex = fs.existsSync(dir);
    if (hadIndex) {
      fs.renameSync(dir, previous);
    }
    try {
      fs.renameSync(staging, dir);
    } catch (err) {
      // The running store still reads `dir`; it gets its index back now, not at the next start.
      if (hadIndex && !fs.existsSync(dir)) {
        fs.renameSync(previous, dir);
      }
      throw err;
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  syncDirectory(path.dirname(dir));
  if (hadIndex) {
    fs.rmSync(previous, { recursive: true, force: true });
  }
}

export function saveChartIndex(dir: string, index: ChartIndex): void {
  dir = path.resolve(dir);
  commitChartIndex(dir, stageChartIndex(dir, index));
}

function isCompleteIndex(dir: string): boolean {
  return Object.values(FILES).every((f) => fs.existsSync(path.join(dir, f)));
}

const STAGING_WRITER = /^(\d+)-(\d+)-/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Removes the staging directories beside `dir` whose writer `owned` claims. */
export function removeStaging(dir: string, owned: (pid: number, thread: number) => boolean): void {
  dir = path.resolve(dir);
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.tmp-`;
  if (!fs.existsSync(parent)) {
    return;
  }
  for (const name of fs.readdirSync(parent)) {
    const writer = name.startsWith(prefix) ? STAGING_WRITER.exec(name.slice(prefix.length)) : null;
    if (writer && owned(Number(writer[1]), Number(writer[2]))) {
      fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }
  }
}

/** Whether this process has yet to recover an index on its main thread. */
let firstRecovery = isMainThread;

/**
 * A crash between the two renames in saveChartIndex leaves `dir` absent and
 * the previous index at `<dir>.old-<suffix>`. Moves the newest complete one
 * back so that build is used again; returns whether it did. Staging that a
 * process which has since exited left half-written is removed first, and the
 * moved-aside copies once `dir` holds a whole index again.
 */
export function recoverChartIndex(dir: string): boolean {
  dir = path.resolve(dir);
  // The index directory is configurable and may be shared, so only staging
  // whose writer has gone is removed; another live server may still commit it.
  // In a container the server gets the same process id at every start, so at
  // the first recovery, which planning the index at start runs before any build,
  // staging under this id is a previous run's.
  const restarted = firstRecovery;
  firstRecovery = false;
  removeStaging(dir, (pid) => (pid === process.pid ? restarted : !isAlive(pid)));
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.old-`;
  if (!fs.existsSync(parent)) {
    return false;
  }
  const moved = fs
    .readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(parent, name));
  if (fs.existsSync(dir)) {
    if (isCompleteIndex(dir)) {
      moved
        .filter((old) => fs.statSync(old).isDirectory() && foreignFile(old) === undefined)
        .forEach((old) => fs.rmSync(old, { recursive: true, force: true }));
    }
    return false;
  }
  const candidates = moved
    .filter(isCompleteIndex)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const newest = candidates[0];
  if (!newest) {
    return false;
  }
  fs.renameSync(newest, dir);
  return true;
}

/** Whether the saved index's pyramid was built under this version's rules; reads its header only. */
export function savedIndexIsCurrent(dir: string): boolean {
  const fd = fs.openSync(path.join(dir, FILES.pyramid), "r");
  try {
    const head = Buffer.alloc(512);
    return isCurrentPyramid(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)));
  } finally {
    fs.closeSync(fd);
  }
}

const hazardsFrom = (json: string): HazardIndex =>
  new HazardIndex(
    (JSON.parse(json) as StoredHazard[]).map((h) => ({ ...h, depth: h.depth ?? -Infinity }))
  );

export interface LoadOptions {
  /** How the pyramid's blocks are read and kept (`block-cache.ts`). */
  cache?: CacheOptions;
  /** Every node in the store's own columns, as a build makes it, for code reading its levels. */
  whole?: boolean;
}

/** Reading every block refuses a damaged one; held whole the reads are kept. */
function checked(pyramid: NodeStore, opts: LoadOptions): NodeStore {
  if (opts.whole) {
    return wholePyramid(pyramid);
  }
  cacheOf(pyramid)?.verifySync();
  return pyramid;
}

/**
 * Loads a saved index, first recovering one that a crash during save left
 * moved aside. The pyramid's blocks are read as queries reach them, but each
 * is inflated once here, so a damaged file is refused now and rebuilt.
 */
export function loadChartIndex(dir: string, opts: LoadOptions = {}): ChartIndex {
  recoverChartIndex(dir);
  const catalogue = parseCatalogue(
    JSON.parse(fs.readFileSync(path.join(dir, FILES.cells), "utf8"))
  );
  const pyramid = checked(openPyramid(path.join(dir, FILES.pyramid), opts.cache), opts);
  const hazards = hazardsFrom(fs.readFileSync(path.join(dir, FILES.hazards), "utf8"));
  return { catalogue, pyramid, hazards };
}

/**
 * `loadChartIndex` with the file reads and the pyramid's inflates off the
 * event loop; parsing the catalogue and hazards stays on it.
 */
export async function loadChartIndexAsync(
  dir: string,
  opts: Pick<LoadOptions, "cache"> = {}
): Promise<ChartIndex> {
  recoverChartIndex(dir);
  const read = (f: string) => fs.promises.readFile(path.join(dir, f));
  const [cells, pyramid, hazards] = await Promise.all([
    read(FILES.cells),
    openPyramidAsync(path.join(dir, FILES.pyramid), opts.cache),
    read(FILES.hazards)
  ]);
  await cacheOf(pyramid)?.verify();
  const catalogue = parseCatalogue(JSON.parse(cells.toString("utf8")));
  return { catalogue, pyramid, hazards: hazardsFrom(hazards.toString("utf8")) };
}
