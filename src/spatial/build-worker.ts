import fs from "fs";
import os from "os";
import v8 from "v8";
import { isMainThread, parentPort, Worker, workerData } from "worker_threads";
import type { CellInfo } from "../ingest/cells";
import { exitWithParent, sendToParent } from "../foundation/child-process";
import { usableMemory } from "../foundation/memory";
import type { ReadCell } from "../ingest/cell-reader";
import { cachedReader, LayerCache } from "../ingest/cell-cache";
import { isEncFile } from "../ingest/cell-source";
import type { EncReader } from "../ingest/enc-read-process";
import { readInChild, readInProcess } from "../ingest/enc-read-process";
import type { EncLayers } from "../ingest/enc-wasm";
import type { DepthFeature } from "../ingest/features";
import type { CellReach } from "./build-items";
import { buildArea, cellReach, DEFAULT_BUILD } from "./build-items";
import type { SavedIndex } from "./build-reuse";
import { copiedRoots, savedIndex, unchangedInfo, writeReach } from "./build-reuse";
import type { ChartIndex } from "./chart-index";
import { isNamedHazard, stageChartIndex } from "./chart-index";
import { HazardIndex } from "./hazards";
import type { IndexParts } from "./index-parts";
import { indexParts } from "./index-parts";
import type { NodeColumns } from "./node-store";
import type { RootRange } from "./pyramid-build";
import type { RegionPart } from "./pyramid-regions";
import { cellsReaching, cellsRootRange, joinParts, rootRegions } from "./pyramid-regions";
import { storeOnBody } from "./store";
import { tileRange } from "../foundation/geo";
import type { BuildBox } from "./build-box";
import { boxCells, boxRect, writeBox } from "./build-box";
import type { ProgressMessage } from "./build-progress";
import { reportProgress, reportProgressTo, throttled } from "./build-progress";
import type { CellSource } from "./parsed-cells";
import { keptParsedBytes, ParsedCells } from "./parsed-cells";
import type { RegionJob, RegionRunner, RegionSharing } from "./region-jobs";
import { regionGroups, runRegions } from "./region-jobs";

export type { RegionJob, RegionRunner, RegionSharing } from "./region-jobs";
export { runRegions } from "./region-jobs";

/**
 * Index build off the event loop: a child process reads the cells, builds
 * the pyramid and stages it, so the 1 Hz look-ahead keeps running while a
 * new Traficom WFS box is indexed (plan §6). Only the main thread moves it
 * into the index directory: a build aborted by stop() may run on after the
 * next start() has saved its own index there.
 *
 * The pyramid is built one root at a time from the cells reaching it, the
 * roots spread over `threads` further workers and joined in root order, so
 * the result does not depend on the thread count.
 */

export interface BuildJob {
  /** Cell sources in catalogue order: S-57 `.000` files, and the Traficom WFS cell's directory. */
  dirs: string[];
  leafZoom: number;
  indexDir: string;
  /** Threads building roots; `defaultThreads()` when absent. */
  threads?: number;
  /** Heap limit shared by the root threads (MB); none when absent. */
  heapMb?: number;
  /**
   * Cell directories whose content may differ from the saved index's while
   * their DSID does not, as the Traficom WFS cell's after a download. When
   * set, the roots that neither these cells nor any cell with a new DSID
   * reach, in the saved build or now, are copied from the index saved in
   * `indexDir` instead of built.
   */
  changed?: string[];
  /**
   * Builds only around the vessel: the cells reaching this box are read and only the tiles
   * within chart position reach of it built, every tile not inside it being no coverage
   * (plan §4.2). Not with `changed`: roots of a saved index built in another box are not
   * copied.
   */
  box?: BuildBox;
  /**
   * The plugin's cell cache (`cell-cache.ts`): S-57 cells' layers and extents are kept there
   * between builds and read from the cells only when their files changed. None when absent.
   */
  cacheDir?: string;
}

/**
 * One thread with up to 4 GiB of RAM, else one per core but one, at most 4. Three threads on
 * 16 Nauvo cell pairs peaked at 974 MB against 481 MB for one; on the 10 km Waddenzee box
 * they saved 18% of the build time for about 500 MB more peak RSS (x86).
 */
export const defaultThreads = (
  memory = usableMemory(),
  cores = os.availableParallelism()
): number => (memory <= 4 * 2 ** 30 ? 1 : Math.max(1, Math.min(4, cores - 1)));

/**
 * S-57 cells' layers, each read once per build through `reader` before the phase that needs
 * them: the cells the survey reads, then the rest of those reaching the roots to build. Read
 * in a child process, gdal3.js's WebAssembly memory is gone before the roots are built.
 * Directories are read by whoever needs them.
 */
class EncReads {
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

  source(dir: string, ref: number): CellSource {
    const layers = this.of(dir);
    return layers ? { dir, ref, layers } : { dir, ref };
  }

  /** The cell parsed, kept for the regions while the budget allows. */
  cell(dir: string, ref: number): ReadCell {
    const cell = this.parsed.cell(this.source(dir, ref));
    this.parsed.trim();
    return cell;
  }
}

interface Survey {
  infos: CellInfo[];
  hazards: DepthFeature[];
  reaches: CellReach[];
  /** Catalogue indices of the cells read anew: all of them without a saved index. */
  changed: number[];
}

/**
 * Reads each cell once for what the index keeps of it: provenance, named
 * hazards and reach. A cell the saved index holds unchanged keeps its saved
 * hazards and reach, and only its DSID is read.
 */
async function survey(
  job: BuildJob,
  saved: SavedIndex | undefined,
  reads: EncReads
): Promise<Survey> {
  const opts = { ...DEFAULT_BUILD, leafZoom: job.leafZoom };
  const out: Survey = { infos: [], hazards: [], reaches: [], changed: [] };
  const kept = job.dirs.map((dir, i) => {
    const was = saved?.cells[i];
    return was && !job.changed?.includes(dir) ? unchangedInfo(dir, was) : undefined;
  });
  await reads.fetch(job.dirs.filter((_, i) => kept[i] === undefined));
  for (const [i, dir] of job.dirs.entries()) {
    const info = kept[i];
    if (saved && info) {
      out.infos.push(info);
      out.hazards.push(...(saved.hazards.get(i) ?? []));
      out.reaches.push(saved.reaches[i] as CellReach);
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
function clipRange(
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

/** A built index with what the next build reuses and the main thread adopts. */
export interface BuiltIndex extends ChartIndex {
  reaches: CellReach[];
  /** The pyramid's columns, views on one buffer, so a reply moves them without a copy. */
  cols: NodeColumns;
  roots: { built: number; copied: number };
}

/**
 * The chart index of `job.dirs`, the pyramid built region by region through `run`, the S-57
 * cells read through `reader` unless the cache in `job.cacheDir` holds them.
 */
export async function buildByRegion(
  whole: BuildJob,
  run: RegionRunner,
  reader: EncReader = readInProcess,
  sharing: RegionSharing = { keepBytes: keptParsedBytes(whole.heapMb) }
): Promise<BuiltIndex> {
  const { cacheDir } = whole;
  const cache =
    cacheDir === undefined ? undefined : LayerCache.open(cacheDir, whole.dirs.filter(isEncFile));
  try {
    const job = whole.box
      ? { ...whole, dirs: boxCells(whole.dirs, whole.box.bbox, cacheDir) }
      : whole;
    const parsed = sharing.parsed ?? new ParsedCells(0);
    const reads = new EncReads(cache ? cachedReader(reader, cache) : reader, parsed);
    return await buildRegions(job, run, reads, sharing);
  } finally {
    await cache?.flush();
  }
}

async function buildRegions(
  job: BuildJob,
  run: RegionRunner,
  reads: EncReads,
  sharing: RegionSharing
): Promise<BuiltIndex> {
  const { minZoom } = DEFAULT_BUILD;
  const within = job.box && boxRect(job.box.bbox);
  const saved = job.changed ? savedIndex(job.indexDir, job.dirs, job.leafZoom) : undefined;
  const s = await survey(job, saved, reads);
  const range = clipRange(
    cellsRootRange(s.reaches, minZoom),
    within && tileRange(minZoom, buildArea(within))
  );
  const roots = range ? rootRegions(range) : [];
  const copies = saved
    ? copiedRoots(
        saved,
        s.changed.flatMap((i) => [s.reaches[i], saved.reaches[i]] as CellReach[]),
        roots
      )
    : new Map<number, NodeColumns>();
  const reaching = roots.map((region, k) =>
    copies.has(k) ? [] : cellsReaching(region, minZoom, s.reaches)
  );
  await reads.fetch(reaching.flat().map((ref) => job.dirs[ref] as string));
  const build = roots.flatMap((_, k) => (copies.has(k) ? [] : [k]));
  const built = new Map<number, NodeColumns>();
  reportProgress({ phase: "roots", done: 0, total: build.length });
  await Promise.all(
    regionGroups(build, roots, sharing.perColumn).map(async (ks) => {
      const refs = [...new Set(ks.flatMap((k) => reaching[k] ?? []))];
      const at = new Map(refs.map((ref, i) => [ref, i]));
      const cols = await run({
        cells: refs.map((ref) => reads.source(job.dirs[ref] as string, ref)),
        regions: ks.map((k) => ({
          region: roots[k] as RootRange,
          cells: (reaching[k] ?? []).map((ref) => at.get(ref) as number)
        })),
        leafZoom: job.leafZoom,
        within,
        keepBytes: sharing.keepBytes
      });
      if (cols.length !== ks.length) {
        throw new Error(`a region job of ${ks.length} regions returned ${cols.length}`);
      }
      ks.forEach((k, j) => built.set(k, cols[j] as NodeColumns));
      reportProgress({ phase: "roots", done: built.size, total: build.length });
    })
  );
  const parts: RegionPart[] = roots.map((region, k) => ({
    region,
    cols: (copies.get(k) ?? built.get(k)) as NodeColumns
  }));
  const { body, cols } = joinParts(minZoom, job.leafZoom, parts);
  return {
    catalogue: { version: 1, cells: s.infos },
    pyramid: storeOnBody(minZoom, job.leafZoom, body, cols),
    hazards: new HazardIndex(s.hazards),
    reaches: s.reaches,
    cols,
    roots: { built: roots.length - copies.size, copied: copies.size }
  };
}

export type { IndexParts } from "./index-parts";
export { adoptIndex, indexParts } from "./index-parts";

/** Each column's buffer once: the columns of a joined pyramid share one. */
export const transfers = (cols: NodeColumns): ArrayBuffer[] => [
  ...new Set(
    Object.values(cols).map((c: NodeColumns[keyof NodeColumns]) => c.buffer as ArrayBuffer)
  )
];

type Reply = { cols?: NodeColumns[]; error?: string };

/**
 * Region builds on `size` threads running this file, each taking the next
 * job when it finishes one. A thread that dies, out of memory for one,
 * fails every job still to come, so the build fails rather than waits.
 */
export function regionPool(
  size: number,
  file = __filename,
  heapMb?: number
): { run: RegionRunner; close: () => void } {
  // The threads run at once and share one limit beside the build process's own: the process
  // holds every region's columns and the joined body, so it keeps its whole limit.
  const resourceLimits =
    heapMb === undefined
      ? undefined
      : { maxOldGenerationSizeMb: Math.max(64, Math.floor(heapMb / size)) };
  const queue: { job: RegionJob; done: (r: Reply) => void }[] = [];
  const idle: Worker[] = [];
  const busy = new Map<Worker, (r: Reply) => void>();
  let failure: string | undefined;
  const pump = (): void => {
    while (failure === undefined && idle.length > 0 && queue.length > 0) {
      const w = idle.pop() as Worker;
      const task = queue.shift() as (typeof queue)[number];
      busy.set(w, task.done);
      w.postMessage(task.job);
    }
  };
  const die = (w: Worker, message: string): void => {
    failure ??= message;
    const i = idle.indexOf(w);
    if (i >= 0) {
      idle.splice(i, 1);
    }
    busy.get(w)?.({ error: failure });
    busy.delete(w);
    queue.splice(0).forEach((t) => t.done({ error: failure }));
  };
  const workers = Array.from({ length: size }, () => {
    const w = new Worker(file, { workerData: { regions: true }, resourceLimits });
    w.on("message", (r: Reply) => {
      const done = busy.get(w);
      busy.delete(w);
      idle.push(w);
      done?.(r);
      pump();
    });
    w.on("error", (err) => die(w, err.message));
    w.on("exit", (code) => die(w, `region thread exited with code ${code}`));
    idle.push(w);
    return w;
  });
  const run: RegionRunner = (job) =>
    new Promise((resolve, reject) => {
      const done = (r: Reply) => (r.cols ? resolve(r.cols) : reject(new Error(r.error)));
      if (failure !== undefined) {
        done({ error: failure });
        return;
      }
      queue.push({ job, done });
      pump();
    });
  const close = (): void => {
    workers.forEach((w) => {
      w.removeAllListeners("exit");
      void w.terminate();
    });
  };
  return { run, close };
}

function stage(job: BuildJob, index: BuiltIndex): { staging: string; index: IndexParts } {
  reportProgress({ phase: "save" });
  const staging = stageChartIndex(job.indexDir, index);
  try {
    writeReach(staging, index.reaches);
    if (job.box) {
      writeBox(staging, { ...job.box, leafZoom: job.leafZoom });
    }
  } catch (err) {
    // The reply carries no staging path to clean up, so a full card would leave a whole copy.
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return { staging, index: indexParts(index) };
}

/**
 * Builds and stages the index, the S-57 cells read through `reader`; resolves with the staging
 * directory and the index to post.
 */
export async function runBuild(
  job: BuildJob,
  reader: EncReader = readInProcess
): Promise<{ staging: string; index: IndexParts }> {
  const threads = job.threads ?? defaultThreads();
  if (threads <= 1) {
    // The survey's parses are kept for the regions, which run on this thread.
    const parsed = new ParsedCells(keptParsedBytes(job.heapMb));
    const run: RegionRunner = (j) => Promise.resolve(runRegions(j, parsed));
    const sharing = { parsed, keepBytes: parsed.budget };
    return stage(job, await buildByRegion(job, run, reader, sharing));
  }
  const pool = regionPool(threads, __filename, job.heapMb);
  let built: BuiltIndex;
  try {
    // A column's roots share most of their cells: one thread parses them once.
    const sharing = { perColumn: true, keepBytes: keptParsedBytes(job.heapMb, threads) };
    built = await buildByRegion(job, pool.run, reader, sharing);
  } finally {
    // Threads still exiting when the index was posted held the main thread's handover back
    // 76–97 ms (32 cells at leaf zoom 20, x86); ended before the staging, 38–54 ms.
    pool.close();
  }
  return stage(job, built);
}

function serveRegions(port: NonNullable<typeof parentPort>): void {
  port.on("message", (job: RegionJob) => {
    try {
      const cols = runRegions(job);
      port.postMessage({ cols }, cols.flatMap(transfers));
    } catch (err) {
      port.postMessage({ error: (err as Error).message });
    }
  });
}

export interface BuildReply {
  ok: boolean;
  staging?: string;
  /** Absent for a pyramid above HELD_WHOLE_NODES: the main thread reads the committed files. */
  index?: IndexParts;
  error?: string;
}

/**
 * Up to this many nodes (about 38 MB of columns) the main thread holds the posted pyramid
 * whole. A larger one is not posted: held whole, a coast-wide index would stay resident after
 * every refresh, and posting it copied the hazards too, 427k of them for the Waddenzee cells.
 */
export const HELD_WHOLE_NODES = 1_000_000;

/** The reply to a finished build: the index itself only when the main thread holds it whole. */
export function builtReply(r: { staging: string; index: IndexParts }): BuildReply {
  const held = r.index.cols.dMin.length <= HELD_WHOLE_NODES;
  return { ok: true, staging: r.staging, ...(held ? { index: r.index } : {}) };
}

/**
 * The build process: takes one job from its parent, builds through `run`, replies and exits,
 * the S-57 cells read in a child of its own. `heapMb` is the job's heap limit, which the
 * reader gets too.
 */
export function serveBuildProcess<J>(
  run: (job: J, reader: EncReader) => Promise<BuildReply>,
  heapMb: (job: J) => number | undefined
): void {
  exitWithParent();
  // --max-old-space-size capped this process's heap at its start; left set, V8 would apply it
  // to every region thread too, over the share regionPool gives each.
  v8.setFlagsFromString("--max-old-space-size=0");
  // Progress goes out ahead of the reply on the same channel; a send that fails is dropped.
  reportProgressTo(
    throttled((progress) =>
      process.send?.({ progress } satisfies ProgressMessage, undefined, {}, () => undefined)
    )
  );
  process.once("message", (job: J) => {
    const reader = readInChild(heapMb(job) ?? DEFAULT_READER_HEAP_MB);
    run(job, reader)
      .catch((err: Error): BuildReply => ({ ok: false, error: err.message }))
      .then(sendToParent)
      .then(
        () => process.exit(0),
        () => process.exit(1)
      );
  });
}

/** A reader's heap when the job sets none. */
const DEFAULT_READER_HEAP_MB = 512;

// The Traficom WFS build process imports this module with its own job, which it leaves alone.
const data = workerData as { regions?: boolean } | undefined;
if (parentPort && data?.regions) {
  serveRegions(parentPort);
} else if (isMainThread && require.main === module && process.send) {
  serveBuildProcess(
    (job: BuildJob, reader) => runBuild(job, reader).then(builtReply),
    (job) => job.heapMb
  );
}
