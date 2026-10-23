import fs from "fs";
import path from "path";
import { writeFileDurable } from "../foundation/durable-file";
import type { Rect } from "../foundation/geo";
import { currentInfo, sourceName } from "../ingest/cell-source";
import type { CellInfo } from "../ingest/cells";
import type { DepthFeature } from "../ingest/features";
import type { CellReach } from "./build-items";
import { DEFAULT_BUILD } from "./build-items";
import { loadChartIndex } from "./chart-index";
import type { NodeColumns, NodeStore } from "./node-store";
import type { RootRange } from "./pyramid-build";
import { rootColumns } from "./pyramid-build";
import { cellsReaching } from "./pyramid-regions";

/**
 * Reuse of a saved index's roots when only some cells changed (plan §4.3). A
 * root depends only on the cells that reach it, so a root that no changed
 * cell reaches, in the saved build or now, comes out of a new build as it is
 * saved, and its nodes are copied instead. A Traficom WFS refresh then
 * builds the roots around the old and new boxes, not every ENC cell's.
 */

/** Each cell's reach, beside the catalogue: the saved build's reach of a cell that has changed. */
export const REACH_FILE = "reach.json";

export function writeReach(staging: string, reaches: readonly CellReach[]): void {
  writeFileDurable(path.join(staging, REACH_FILE), JSON.stringify({ version: 1, cells: reaches }));
}

const isRect = (r: unknown): r is Rect =>
  typeof r === "object" &&
  r !== null &&
  ["minX", "minY", "maxX", "maxY"].every((k) => Number.isFinite((r as Record<string, unknown>)[k]));

function readReach(dir: string, count: number): CellReach[] {
  const json = JSON.parse(fs.readFileSync(path.join(dir, REACH_FILE), "utf8")) as {
    version?: unknown;
    cells?: unknown;
  };
  const cells = json.cells as CellReach[];
  if (
    json.version !== 1 ||
    !Array.isArray(cells) ||
    cells.length !== count ||
    !cells.every((c) => isRect(c.box) && isRect(c.coverage) && Number.isFinite(c.radius))
  ) {
    throw new Error(`${REACH_FILE} does not match the catalogue`);
  }
  return cells;
}

/** The saved index a build can take roots from. */
export interface SavedIndex {
  cells: CellInfo[];
  reaches: CellReach[];
  /** Named hazards by catalogue index, in feature order. */
  hazards: Map<number, DepthFeature[]>;
  pyramid: NodeStore;
}

/** JSON drops undefined fields, and a parsed catalogue spells out some a cell's DSID leaves out. */
const canonical = (info: object): string =>
  JSON.stringify(
    Object.entries(info)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
  );

/**
 * The provenance of the cell at `source` when it is what `saved` records, else undefined:
 * an S-57 cell's files unchanged since, or a directory's DSID and datum areas.
 */
export function unchangedInfo(source: string, saved: CellInfo): CellInfo | undefined {
  const now = currentInfo(source);
  if (now.files !== undefined) {
    return now.name === saved.name && now.files === saved.files ? saved : undefined;
  }
  return canonical(now) === canonical(saved) ? (now as CellInfo) : undefined;
}

/**
 * The index saved in `indexDir` when it holds the cells of `dirs` by name in
 * the same order, at `leafZoom`, with each cell's reach; otherwise undefined
 * and the build starts afresh. A catalogue index names the same cell in both
 * builds, so the copied nodes' cell references stay right.
 */
export function savedIndex(
  indexDir: string,
  dirs: readonly string[],
  leafZoom: number
): SavedIndex | undefined {
  let saved: ReturnType<typeof loadChartIndex>;
  let reaches: CellReach[];
  try {
    // Copying roots reads every level, so the blocks are joined rather than read on demand.
    saved = loadChartIndex(indexDir, { whole: true });
    reaches = readReach(indexDir, saved.catalogue.cells.length);
  } catch {
    return undefined;
  }
  const { pyramid, catalogue } = saved;
  const names = dirs.map(sourceName);
  if (
    pyramid.minZoom !== DEFAULT_BUILD.minZoom ||
    pyramid.leafZoom !== leafZoom ||
    names.join("\n") !== catalogue.cells.map((c) => c.name).join("\n")
  ) {
    return undefined;
  }
  const hazards = new Map<number, DepthFeature[]>();
  for (const f of saved.hazards.features) {
    const own = hazards.get(f.cellRef) ?? [];
    own.push(f);
    hazards.set(f.cellRef, own);
  }
  return { cells: catalogue.cells, reaches, hazards, pyramid };
}

/**
 * The saved nodes of each root in `roots` (single roots) that needs no build:
 * reached by none of `changed` (the reaches of every changed cell then and
 * now). A build stores every root of its range, so a root without saved
 * nodes lay outside the saved build's range and is built. Keyed by position
 * in `roots`.
 */
export function copiedRoots(
  saved: SavedIndex,
  changed: readonly CellReach[],
  roots: readonly RootRange[]
): Map<number, NodeColumns> {
  const { minZoom } = saved.pyramid;
  const out = new Map<number, NodeColumns>();
  roots.forEach((root, k) => {
    if (cellsReaching(root, minZoom, changed).length > 0) {
      return;
    }
    const cols = rootColumns(saved.pyramid, root.minX, root.minY);
    if (cols.z.length > 0) {
      out.set(k, cols);
    }
  });
  return out;
}
