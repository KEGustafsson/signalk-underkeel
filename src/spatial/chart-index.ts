import fs from "fs";
import path from "path";
import type { ReadCell } from "../ingest/cell-reader";
import type { CellCatalogue } from "../ingest/cells";
import { parseCatalogue } from "../ingest/cells";
import type { ChartFeature, DepthFeature } from "../ingest/features";
import { HazardIndex } from "./hazards";
import type { NodeStore } from "./node-store";
import type { BuildOptions } from "./pyramid-build";
import { buildPyramid } from "./pyramid-build";
import { deserializePyramid, serializePyramid } from "./store";

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
 * Writes the three index files into a staging directory beside `dir` and
 * swaps it in only after all of them are written, so a crash or a full disk
 * never leaves a catalogue from one build beside a pyramid from another.
 */
export function saveChartIndex(dir: string, index: ChartIndex): void {
  const staging = `${dir}.tmp-${process.pid}`;
  const previous = `${dir}.old-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, FILES.cells), JSON.stringify(index.catalogue, null, 2));
  fs.writeFileSync(path.join(staging, FILES.pyramid), serializePyramid(index.pyramid));
  const hazards: StoredHazard[] = index.hazards.features.map((f) => ({
    ...f,
    depth: Number.isFinite(f.depth) ? f.depth : null
  }));
  fs.writeFileSync(path.join(staging, FILES.hazards), JSON.stringify(hazards));
  const hadIndex = fs.existsSync(dir);
  if (hadIndex) {
    fs.rmSync(previous, { recursive: true, force: true });
    fs.renameSync(dir, previous);
  }
  fs.renameSync(staging, dir);
  if (hadIndex) {
    fs.rmSync(previous, { recursive: true, force: true });
  }
}

function isCompleteIndex(dir: string): boolean {
  return Object.values(FILES).every((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * A crash between the two renames in saveChartIndex leaves `dir` absent and
 * the previous index at `<dir>.old-<pid>`. Moves the newest complete one
 * back so that build is used again; returns whether it did.
 */
export function recoverChartIndex(dir: string): boolean {
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
