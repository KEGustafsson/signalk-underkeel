import type { ReadCell } from "../ingest/cell-reader";
import type { CellInfo } from "../ingest/cells";
import { isEncFile } from "../ingest/cell-source";
import type { EncReader } from "../ingest/enc-read-process";
import type { EncLayers } from "../ingest/enc-wasm";
import type { DepthFeature } from "../ingest/features";
import type { CellReach } from "./build-items";
import { cellReach, DEFAULT_BUILD } from "./build-items";
import { reportProgress } from "./build-progress";
import type { SavedIndex } from "./build-reuse";
import { unchangedInfo } from "./build-reuse";
import { isNamedHazard } from "./chart-index";
import type { CellSource, ParsedCells } from "./parsed-cells";
import type { RootRange } from "./pyramid-build";

/** What a build reads of its cells before the roots: their layers, provenance and reach. */

/**
 * S-57 cells' layers, each read once per build through `reader` before the phase that needs
 * them: the cells the survey reads, then the rest of those reaching the roots to build. Read
 * in a child process, gdal3.js's WebAssembly memory is gone before the roots are built.
 * Directories are read by whoever needs them.
 */
export class EncReads {
  private readonly layers = new Map<string, EncLayers>();

  constructor(
    private readonly reader: EncReader,
    private readonly parsed: ParsedCells
  ) {}

  async fetch(sources: readonly string[]): Promise<void> {
    const files = sources.filter((s) => isEncFile(s) && !this.layers.has(s));
    if (files.length === 0) {
      return;
    }
    const done = this.layers.size;
    reportProgress({ phase: "cells", done, total: done + files.length });
    for (const [file, layers] of await this.reader(files)) {
      this.layers.set(file, layers);
    }
    reportProgress({ phase: "cells", done: this.layers.size, total: this.layers.size });
  }

  of(source: string): EncLayers | undefined {
    if (!isEncFile(source)) {
      return undefined;
    }
    const layers = this.layers.get(source);
    if (!layers) {
      throw new Error(`${source} was not read before the build needed it`);
    }
    return layers;
  }

  source(dir: string, ref: number, id?: string): CellSource {
    const layers = this.of(dir);
    const c: CellSource = layers ? { dir, ref, layers } : { dir, ref };
    return id === undefined ? c : { ...c, id };
  }

  /** The cell parsed, kept for the regions while the budget allows. */
  cell(dir: string, ref: number): ReadCell {
    const cell = this.parsed.cell(this.source(dir, ref));
    this.parsed.trim();
    return cell;
  }
}

export interface Survey {
  infos: CellInfo[];
  hazards: DepthFeature[];
  reaches: CellReach[];
  /** Catalogue indices of the cells read anew: all of them without a saved index. */
  changed: number[];
}

/**
 * Reads each cell once for what the index keeps of it: provenance, named
 * hazards and reach. A cell the saved index holds unchanged keeps its saved
 * hazards and reach, and only its DSID is read. Against a box index a cell is
 * unchanged when its identity (`ids`, `sourceIdentity`) is the one saved.
 */
export async function survey(
  job: { dirs: string[]; leafZoom: number; changed?: string[] },
  saved: SavedIndex | undefined,
  reads: EncReads,
  ids?: string[]
): Promise<Survey> {
  const opts = { ...DEFAULT_BUILD, leafZoom: job.leafZoom };
  const out: Survey = { infos: [], hazards: [], reaches: [], changed: [] };
  const kept = job.dirs.map((dir, i) => {
    const j = saved?.refs[i];
    const was = j === undefined ? undefined : saved?.cells[j];
    if (!saved || j === undefined || !was) {
      return undefined;
    }
    if (saved.tiles) {
      return ids !== undefined && saved.tiles.ids[j] === ids[i] ? was : undefined;
    }
    return job.changed?.includes(dir) ? undefined : unchangedInfo(dir, was);
  });
  await reads.fetch(job.dirs.filter((_, i) => kept[i] === undefined));
  for (const [i, dir] of job.dirs.entries()) {
    const info = kept[i];
    const j = saved?.refs[i];
    if (saved && info && j !== undefined) {
      out.infos.push(info);
      const hazards = saved.hazards.get(j) ?? [];
      out.hazards.push(...(j === i ? hazards : hazards.map((f) => ({ ...f, cellRef: i }))));
      out.reaches.push(saved.reaches[j] as CellReach);
      continue;
    }
    const cell = reads.cell(dir, i);
    out.infos.push(cell.info);
    out.hazards.push(...cell.features.filter(isNamedHazard));
    out.reaches.push(cellReach(cell.features, opts));
    out.changed.push(i);
  }
  return out;
}

/** The roots of `range` that `box` also holds; all of `range` without a box. */
export function clipRange(
  range: RootRange | undefined,
  box: RootRange | undefined
): RootRange | undefined {
  if (!range || !box) {
    return range;
  }
  const r = {
    minX: Math.max(range.minX, box.minX),
    minY: Math.max(range.minY, box.minY),
    maxX: Math.min(range.maxX, box.maxX),
    maxY: Math.min(range.maxY, box.maxY)
  };
  return r.minX <= r.maxX && r.minY <= r.maxY ? r : undefined;
}
