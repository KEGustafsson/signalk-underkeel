import fs from "fs";
import path from "path";
import { isMainThread } from "worker_threads";
import type { Bbox, WfsFetch } from "./ingest/wfs";
import type { WfsFeature } from "./ingest/wfs-fetch";
import type { Limit } from "./ingest/wfs-fetch";
import { fetchLayer, limiter, num, retried, WFS_LIMITS } from "./ingest/wfs-fetch";
import { reportProgress } from "./spatial/build-progress";
import { serveBuildProcess } from "./spatial/build-worker";
import type { Survey, SurveyTile } from "./survey";
import { markPolygon, surveyGrid, surveyTiles } from "./survey";

/**
 * The depth survey off the event loop (`survey.ts`): the region's Traficom WFS depth and
 * dredged areas downloaded tile by tile, each tile marked on the grid and dropped before the
 * next, so the memory is one tile's features and the grid however large the region. It runs
 * in a child process (`runBuildProcess`) and writes the grid to its staging directory.
 */

export interface SurveyJob {
  url: string;
  region: Bbox;
  cellMetres: number;
  /** The directory the grid is written to; the main thread reads and removes it. */
  staging: string;
  heapMb?: number;
  lowPriority?: boolean;
}

/** The grid's header, beside its depths in DEPTHS_FILE. */
export type SurveyHeader = Omit<Survey, "depth">;

export const HEADER_FILE = "survey.json";
export const DEPTHS_FILE = "depths.f32";

const LAYERS = [
  // A depth area's deeper bound, a dredged area's dredged depth: the most the cell may hold.
  { typeName: "rajoitettu:DepthArea_A", depth: ["DRVAL2", "DRVAL1"] },
  { typeName: "rajoitettu:DredgedArea_A", depth: ["DRVAL1", "DRVAL2"] }
] as const;

type Rings = number[][][];

function polygons(f: WfsFeature): Rings[] {
  const g = f.geometry;
  if (g?.type === "Polygon") {
    return [g.coordinates as Rings];
  }
  return g?.type === "MultiPolygon" ? (g.coordinates as Rings[]) : [];
}

/**
 * Tiles downloaded at once. An 11 km tile of the archipelago off Turku is 9 MB of depth areas
 * that the WFS sends in about 7 s; two at a time keep the parsed features well inside the build
 * heap of a 1 GB machine while the link stays busy.
 */
const TILES_AT_ONCE = 2;

/** Marks the depth and dredged areas of `tile`, downloaded with `limit`, on `g`. */
async function surveyTile(
  g: Survey,
  tile: SurveyTile,
  url: string,
  fetch: WfsFetch,
  limit: Limit,
  signal?: AbortSignal
): Promise<void> {
  for (const layer of LAYERS) {
    const features = await fetchLayer({
      fetch,
      base: url,
      typeName: layer.typeName,
      bbox: tile.bbox,
      limit,
      signal
    });
    const [first, second] = layer.depth;
    for (const f of features) {
      const v = num(f.properties?.[first]) ?? num(f.properties?.[second]);
      if (v !== undefined) {
        for (const rings of polygons(f)) {
          markPolygon(g, rings, v, tile.range);
        }
      }
    }
  }
}

/** The survey of `job.region` from the WFS at `job.url`, fetched with `fetch`. */
export async function runSurvey(
  job: Omit<SurveyJob, "staging">,
  fetch: WfsFetch,
  signal?: AbortSignal
): Promise<Survey> {
  const g = surveyGrid(job.region, job.cellMetres);
  const limit = limiter(WFS_LIMITS.concurrency);
  const tiles = surveyTiles(g);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tiles.length) {
      const tile = tiles[next++] as SurveyTile;
      await retried(() => surveyTile(g, tile, job.url, fetch, limit, signal), signal);
      reportProgress({ phase: "download", done: next, total: tiles.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(TILES_AT_ONCE, tiles.length) }, worker));
  return g;
}

/** Writes the grid into `dir`, made afresh. */
export function writeSurvey(dir: string, g: Survey): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { depth, ...header } = g;
  fs.writeFileSync(path.join(dir, DEPTHS_FILE), new Uint8Array(depth.buffer));
  fs.writeFileSync(path.join(dir, HEADER_FILE), JSON.stringify(header));
}

/** The grid written into `dir`. */
export function readSurvey(dir: string): Survey {
  const header = JSON.parse(fs.readFileSync(path.join(dir, HEADER_FILE), "utf8")) as SurveyHeader;
  const bytes = fs.readFileSync(path.join(dir, DEPTHS_FILE));
  const depth = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(depth.buffer).set(bytes);
  if (depth.length !== header.cols * header.rows) {
    throw new Error(
      `survey in ${dir} holds ${depth.length} cells, not ${header.cols * header.rows}`
    );
  }
  return { ...header, depth };
}

if (isMainThread && require.main === module && process.send) {
  serveBuildProcess(
    async (job: SurveyJob) => {
      writeSurvey(job.staging, await runSurvey(job, globalThis.fetch));
      return { ok: true, staging: job.staging };
    },
    (job) => job.heapMb,
    (job) => job.lowPriority === true
  );
}
