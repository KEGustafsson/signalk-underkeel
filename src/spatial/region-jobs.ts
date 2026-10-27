import type { Rect } from "../foundation/geo";
import { DEFAULT_BUILD, prepareItems } from "./build-items";
import type { NodeColumns } from "./node-store";
import type { CellSource } from "./parsed-cells";
import { cellKey, ParsedCells } from "./parsed-cells";
import type { RootRange } from "./pyramid-build";
import { buildRegion, regionReach } from "./pyramid-regions";

/**
 * Regions of roots built one after another, each from the cells that reach it. A cell
 * reaching several of them is parsed once while `keepBytes` of parsed cells allow.
 */
export interface RegionJob {
  /** An S-57 cell comes with its layers, read once by the build; a directory is read here. */
  cells: CellSource[];
  /** The regions in build order, each with the positions in `cells` of those reaching it. */
  regions: { region: RootRange; cells: number[] }[];
  leafZoom: number;
  /** The box in Mercator metres (`BuildOptions.within`): no tile outside it reads as covered. */
  within?: Rect;
  /** Estimated heap of parsed cells kept from one region for a later one. */
  keepBytes: number;
}

/** Builds a job's regions: each one's columns, in the job's order. */
export type RegionRunner = (job: RegionJob) => Promise<NodeColumns[]>;

/** How a build hands its regions to the runner. */
export interface RegionSharing {
  /** Parsed cells the survey keeps for the regions, where the runner builds on this thread. */
  parsed?: ParsedCells;
  /** One job per column of roots, for a pool of threads; else one job of every region. */
  perColumn?: boolean;
  /** Each job's `keepBytes`. */
  keepBytes: number;
}

/** The roots `build` holds, in order, as the jobs `perColumn` asks for. */
export function regionGroups(build: number[], roots: RootRange[], perColumn = false): number[][] {
  if (!perColumn) {
    return build.length > 0 ? [build] : [];
  }
  const columns = new Map<number, number[]>();
  for (const k of build) {
    const x = (roots[k] as RootRange).minX;
    columns.set(x, [...(columns.get(x) ?? []), k]);
  }
  return [...columns.values()];
}

/**
 * Builds the job's regions in order from the cells reaching each. A cell can reach many
 * regions; only its features that reach the one built are indexed. Parsed cells are kept in
 * `parsed` up to its budget, those used next soonest, so a cell reaching several regions is
 * parsed once while they fit.
 */
export function runRegions(job: RegionJob, parsed = new ParsedCells(job.keepBytes)): NodeColumns[] {
  const opts = { ...DEFAULT_BUILD, leafZoom: job.leafZoom, within: job.within };
  const uses = new Map<string, number[]>();
  job.regions.forEach(({ cells }, k) =>
    cells.forEach((i) => {
      const key = cellKey(job.cells[i] as CellSource);
      uses.set(key, [...(uses.get(key) ?? []), k]);
    })
  );
  const after = (k: number) => (key: string) => uses.get(key)?.find((j) => j > k) ?? Infinity;
  parsed.trim(after(-1));
  return job.regions.map(({ region, cells }, k) => {
    const keep = regionReach(region, opts.minZoom);
    const features = cells.flatMap((i) => parsed.cell(job.cells[i] as CellSource).features);
    const cols = buildRegion(prepareItems(features, opts, keep), opts, region);
    parsed.trim(after(k));
    return cols;
  });
}
