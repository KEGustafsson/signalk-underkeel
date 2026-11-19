import fs from "fs";
import path from "path";
import { isMainThread } from "worker_threads";
import type { Bbox, WfsFetch } from "./ingest/wfs";
import type { WfsFeature } from "./ingest/wfs-fetch";
import { forEachPage, limiter, num } from "./ingest/wfs-fetch";
import { reportProgress } from "./spatial/build-progress";
import { serveBuildProcess } from "./spatial/build-worker";
import type { Survey, SurveyTile } from "./survey";
import { markPolygon, surveyGrid, surveyTiles } from "./survey";

/**
 * The depth survey off the event loop (`survey.ts`): the region's Traficom WFS depth and
 * dredged areas downloaded tile by tile and page by page, each page marked on the grid and
 * dropped before the next, so the memory is one page's features and the grid however large the
 * region. It runs
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
export type SurveyHeader = Omit<Survey, "depth" | "shallowest">;

export const HEADER_FILE = "survey.json";
export const DEPTHS_FILE = "depths.f32";
export const SHALLOWEST_FILE = "shallowest.f32";

const LAYERS = [
  // A depth area's deeper bound, a dredged area's dredged depth: the most the cell may hold;
  // the shallower bound, the dredged depth: the least.
  {
    typeName: "rajoitettu:DepthArea_A",
    depth: ["DRVAL2", "DRVAL1"],
    shallow: ["DRVAL1", "DRVAL2"]
  },
  {
    typeName: "rajoitettu:DredgedArea_A",
    depth: ["DRVAL1", "DRVAL2"],
    shallow: ["DRVAL1", "DRVAL2"]
  }
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
 * Features asked for per page. A depth area of the archipelago off Turku is 6 to 20 KB, so a page
 * is a few MB: parsed, marked and dropped well inside the build heap of a 1 GB machine.
 */
const PAGE_FEATURES = 250;

/** Marks the depth and dredged areas of `tile` on `g`, page by page. */
async function surveyTile(
  g: Survey,
  tile: SurveyTile,
  url: string,
  fetch: WfsFetch,
  signal?: AbortSignal
): Promise<void> {
  const limit = limiter(1);
  for (const layer of LAYERS) {
    const [first, second] = layer.depth;
    const [low, lower] = layer.shallow;
    const r = { fetch, base: url, typeName: layer.typeName, bbox: tile.bbox, limit, signal };
    await forEachPage(r, PAGE_FEATURES, (features) => {
      for (const f of features) {
        const v = num(f.properties?.[first]) ?? num(f.properties?.[second]);
        const w = num(f.properties?.[low]) ?? num(f.properties?.[lower]) ?? v;
        if (v !== undefined) {
          for (const rings of polygons(f)) {
            markPolygon(g, rings, v, tile.range, w);
          }
        }
      }
    });
  }
}

/**
 * The survey of `job.region` from the WFS at `job.url`, fetched with `fetch`, tile by tile. The
 * WFS answers with whole areas, not clipped to the box, so a tile is as large as its spans
 * allow: smaller ones download the same large areas again and again.
 */
export async function runSurvey(
  job: Omit<SurveyJob, "staging">,
  fetch: WfsFetch,
  signal?: AbortSignal
): Promise<Survey> {
  const g = surveyGrid(job.region, job.cellMetres);
  const tiles = surveyTiles(g);
  for (const [i, tile] of tiles.entries()) {
    await surveyTile(g, tile, job.url, fetch, signal);
    reportProgress({ phase: "download", done: i + 1, total: tiles.length });
  }
  return g;
}

/** Writes the grid into `dir`, made afresh. */
export function writeSurvey(dir: string, g: Survey): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { depth, shallowest, ...header } = g;
  fs.writeFileSync(path.join(dir, DEPTHS_FILE), new Uint8Array(depth.buffer));
  fs.writeFileSync(path.join(dir, SHALLOWEST_FILE), new Uint8Array(shallowest.buffer));
  fs.writeFileSync(path.join(dir, HEADER_FILE), JSON.stringify(header));
}

/** The Float32 grid in `file`, which must hold `cells` values. */
function readGrid(file: string, cells: number): Float32Array {
  const bytes = fs.readFileSync(file);
  const grid = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(grid.buffer).set(bytes);
  if (grid.length !== cells) {
    throw new Error(`survey ${file} holds ${grid.length} cells, not ${cells}`);
  }
  return grid;
}

/** The grid written into `dir`. */
export function readSurvey(dir: string): Survey {
  const header = JSON.parse(fs.readFileSync(path.join(dir, HEADER_FILE), "utf8")) as SurveyHeader;
  const cells = header.cols * header.rows;
  return {
    ...header,
    depth: readGrid(path.join(dir, DEPTHS_FILE), cells),
    shallowest: readGrid(path.join(dir, SHALLOWEST_FILE), cells)
  };
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
