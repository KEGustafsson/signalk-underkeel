import fs from "fs";
import path from "path";
import initGdalJs = require("gdal3.js/node.js");
import type { CellLayers, ReadCell } from "./cell-reader";
import { readCellLayers } from "./cell-reader";
import type { GeoJsonFeature, GeoJsonFeatureCollection } from "./s57-geojson";
import { POSITION_LAYER } from "./s57-geojson";

/**
 * Reads an S-57 cell straight from its `.000` and update files with GDAL
 * compiled to WebAssembly (gdal3.js): no export step, no container. The
 * layers come back as GeoJSON objects in memory and go through the same
 * reader as an exported directory, so every parsing rule is shared. The
 * options are those of `scripts/enc-to-geojson.sh`, primitives included for
 * the cell's positional quality.
 */

const S57_OPTIONS = [
  "RETURN_PRIMITIVES=ON",
  "RETURN_LINKAGES=OFF",
  "LNAM_REFS=ON",
  "UPDATES=APPLY",
  "SPLIT_MULTIPOINT=ON",
  "ADD_SOUNDG_DEPTH=ON"
].join(",");

type Gdal = Awaited<ReturnType<typeof initGdalJs>>;

let gdal: Promise<Gdal> | undefined;
/** One GDAL call at a time: the WebAssembly instance is single-threaded. */
let queue: Promise<unknown> = Promise.resolve();

function gdalJs(): Promise<Gdal> {
  gdal ??= initGdalJs({
    env: { OGR_S57_OPTIONS: S57_OPTIONS },
    logHandler: () => undefined,
    errorHandler: () => undefined
  });
  return gdal;
}

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** The base cell and its updates (`.001`, `.002`, …) beside it, in order. */
export function cellFiles(file: string): string[] {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const updates = fs
    .readdirSync(dir)
    .filter(
      (f) => f.startsWith(`${base}.`) && /^\.\d{3}$/.test(path.extname(f)) && !f.endsWith(".000")
    )
    .sort();
  return [file, ...updates.map((f) => path.join(dir, f))];
}

interface OgrinfoLayer {
  name: string;
  features?: GeoJsonFeature[];
}

/** QUAPOS 1 (surveyed), 10 (precisely known) and 11 (calculated); absent means surveyed. */
const SURVEYED = new Set([1, 10, 11]);

const props = (f: GeoJsonFeature): Record<string, unknown> => f.properties ?? {};

function lowAccuracy(p: Record<string, unknown>): boolean {
  const q = p.QUAPOS;
  return (typeof q === "number" && !SURVEYED.has(q)) || typeof p.POSACC === "number";
}

/**
 * The positional quality layer as the export script writes it: edges not
 * surveyed, the connected nodes they end at, and nodes of their own low
 * accuracy, from GDAL's primitive layers.
 */
function positionLayer(layers: Map<string, GeoJsonFeature[]>): GeoJsonFeatureCollection {
  const edges = (layers.get("Edge") ?? []).filter((f) => lowAccuracy(props(f)));
  const ends = new Set(edges.flatMap((f) => [props(f).NAME_RCID_0, props(f).NAME_RCID_1]));
  const record = (prim: string, f: GeoJsonFeature, extra: Record<string, unknown> = {}) => ({
    ...f,
    properties: {
      PRIM: prim,
      RCID: props(f).RCID,
      QUAPOS: props(f).QUAPOS,
      POSACC: props(f).POSACC,
      ...extra
    }
  });
  return {
    type: "FeatureCollection",
    features: [
      ...edges.map((f) =>
        record("edge", f, { NODE0: props(f).NAME_RCID_0, NODE1: props(f).NAME_RCID_1 })
      ),
      ...(layers.get("ConnectedNode") ?? [])
        .filter((f) => lowAccuracy(props(f)) || ends.has(props(f).RCID))
        .map((f) => record("cnode", f)),
      ...(layers.get("IsolatedNode") ?? [])
        .filter((f) => lowAccuracy(props(f)))
        .map((f) => record("inode", f))
    ]
  };
}

/** Every layer of a cell, read in one pass. */
async function readLayers(file: string): Promise<CellLayers> {
  const g = await gdalJs();
  const layers = await serial(async () => {
    const { datasets, errors } = await g.open(cellFiles(file));
    const ds = datasets[0];
    if (!ds) {
      throw new Error(`GDAL cannot open ${file}: ${errors.join("; ") || "no dataset"}`);
    }
    try {
      const info = (await g.ogrinfo(ds, ["-json", "-features"])) as { layers?: OgrinfoLayer[] };
      return new Map((info.layers ?? []).map((l) => [l.name, l.features ?? []]));
    } finally {
      await g.close(ds);
    }
  });
  const position = positionLayer(layers);
  return (layer) => {
    if (layer === POSITION_LAYER) {
      return position;
    }
    const features = layers.get(layer);
    return features && { type: "FeatureCollection", features };
  };
}

/** A cell read from its `.000` and updates, as `readCellDirectory` reads an export. */
export async function readEncCell(
  file: string,
  cellRef: number,
  bandOverride?: number
): Promise<ReadCell> {
  const name = path.basename(file, path.extname(file));
  return readCellLayers(await readLayers(file), name, cellRef, bandOverride, file);
}
