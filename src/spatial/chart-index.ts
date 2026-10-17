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

export function buildChartIndex(cells: ReadCell[], opts: Partial<BuildOptions> = {}): ChartIndex {
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

export function saveChartIndex(dir: string, index: ChartIndex): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILES.cells), JSON.stringify(index.catalogue, null, 2));
  fs.writeFileSync(path.join(dir, FILES.pyramid), serializePyramid(index.pyramid));
  const hazards: StoredHazard[] = index.hazards.features.map((f) => ({
    ...f,
    depth: Number.isFinite(f.depth) ? f.depth : null
  }));
  fs.writeFileSync(path.join(dir, FILES.hazards), JSON.stringify(hazards));
}

export function loadChartIndex(dir: string): ChartIndex {
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
