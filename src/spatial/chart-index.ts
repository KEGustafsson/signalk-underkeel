import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { threadId } from "worker_threads";
import type { ReadCell } from "../ingest/cell-reader";
import type { CellCatalogue } from "../ingest/cells";
import { parseCatalogue } from "../ingest/cells";
import type { ChartFeature, DepthFeature } from "../ingest/features";
import { HazardIndex } from "./hazards";
import type { NodeStore } from "./node-store";
import type { BuildOptions } from "./pyramid-build";
import { buildPyramid } from "./pyramid-build";
import { deserializePyramid, isCurrentPyramid, serializePyramid } from "./store";

/** The queryable chart: provenance, the min-depth pyramid and the hazard tree. */
export interface ChartIndex {
  catalogue: CellCatalogue;
  pyramid: NodeStore;
  hazards: HazardIndex;
}

/** Object classes kept in the hazard tree so results can name what they hit. */
const HAZARD_CLASSES = new Set(["UWTROC", "WRECKS", "OBSTRN", "SOUNDG"]);

function isNamedHazard(f: ChartFeature): f is DepthFeature {
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
 * Writes the three index files into a new staging directory beside `dir`
 * and returns its path; `commitChartIndex` swaps it in.
 */
export function stageChartIndex(dir: string, index: ChartIndex): string {
  // A worker thread shares the process id, so the id alone would let a WFS
  // rebuild and a save on the main thread remove each other's directories.
  const suffix = `${process.pid}-${threadId}-${randomBytes(4).toString("hex")}`;
  const staging = `${dir}.tmp-${suffix}`;
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, FILES.cells), JSON.stringify(index.catalogue, null, 2));
  fs.writeFileSync(path.join(staging, FILES.pyramid), serializePyramid(index.pyramid));
  const hazards: StoredHazard[] = index.hazards.features.map((f) => ({
    ...f,
    depth: Number.isFinite(f.depth) ? f.depth : null
  }));
  fs.writeFileSync(path.join(staging, FILES.hazards), JSON.stringify(hazards));
  return staging;
}

/**
 * Moves a staged index into `dir` only after all its files are written, so
 * a crash or a full disk never leaves a catalogue from one build beside a
 * pyramid from another.
 */
export function commitChartIndex(dir: string, staging: string): void {
  const previous = `${dir}.old-${path.basename(staging).slice(`${path.basename(dir)}.tmp-`.length)}`;
  const hadIndex = fs.existsSync(dir);
  if (hadIndex) {
    fs.renameSync(dir, previous);
  }
  fs.renameSync(staging, dir);
  if (hadIndex) {
    fs.rmSync(previous, { recursive: true, force: true });
  }
}

export function saveChartIndex(dir: string, index: ChartIndex): void {
  commitChartIndex(dir, stageChartIndex(dir, index));
}

function isCompleteIndex(dir: string): boolean {
  return Object.values(FILES).every((f) => fs.existsSync(path.join(dir, f)));
}

const STAGING_WRITER = /^(\d+)-(\d+)-/;

/** Removes the staging directories beside `dir` whose writer `owned` claims. */
export function removeStaging(dir: string, owned: (pid: number, thread: number) => boolean): void {
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

/**
 * A crash between the two renames in saveChartIndex leaves `dir` absent and
 * the previous index at `<dir>.old-<suffix>`. Moves the newest complete one
 * back so that build is used again; returns whether it did. Staging that a
 * dead process left half-written is removed first.
 */
export function recoverChartIndex(dir: string): boolean {
  // One server owns a data directory, so staging from another process was
  // left by one that died mid-build.
  removeStaging(dir, (pid) => pid !== process.pid);
  if (fs.existsSync(dir)) {
    return false;
  }
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.old-`;
  if (!fs.existsSync(parent)) {
    return false;
  }
  const candidates = fs
    .readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(parent, name))
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

/** Loads a saved index, first recovering one that a crash during save left moved aside. */
export function loadChartIndex(dir: string): ChartIndex {
  recoverChartIndex(dir);
  const catalogue = parseCatalogue(
    JSON.parse(fs.readFileSync(path.join(dir, FILES.cells), "utf8"))
  );
  const pyramid = deserializePyramid(fs.readFileSync(path.join(dir, FILES.pyramid)));
  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, FILES.hazards), "utf8")
  ) as StoredHazard[];
  const hazards = new HazardIndex(stored.map((h) => ({ ...h, depth: h.depth ?? -Infinity })));
  return { catalogue, pyramid, hazards };
}
