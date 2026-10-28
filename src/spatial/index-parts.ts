import type { CellCatalogue } from "../ingest/cells";
import { parseCatalogue } from "../ingest/cells";
import type { BuiltIndex } from "./build-worker";
import type { ChartIndex } from "./chart-index";
import { readHazards, serializeHazards } from "./hazard-file";
import type { NodeColumns } from "./node-store";
import { NodeStore } from "./node-store";

/** What a build posts to the main thread besides its staging directory. */
export interface IndexParts {
  catalogue: CellCatalogue;
  /** The hazards as `hazards.bin` holds them. */
  hazards: Uint8Array;
  minZoom: number;
  leafZoom: number;
  cols: NodeColumns;
  roots: BuiltIndex["roots"];
}

export function indexParts(b: BuiltIndex): IndexParts {
  const { catalogue, hazards, pyramid, cols, roots } = b;
  const { minZoom, leafZoom } = pyramid;
  // As `cells.json` saves it, so the catalogue handed over compares equal to one loaded.
  const parsed = parseCatalogue(catalogue);
  return { catalogue: parsed, hazards: serializeHazards(hazards), minZoom, leafZoom, cols, roots };
}

/**
 * The index a build posted, adopted on the main thread without reading the
 * saved files: the columns arrive moved, the hazards as their file's bytes.
 */
export function adoptIndex(p: IndexParts): ChartIndex {
  return {
    catalogue: p.catalogue,
    pyramid: NodeStore.fromColumns(p.minZoom, p.leafZoom, p.cols),
    hazards: readHazards(p.hazards)
  };
}
