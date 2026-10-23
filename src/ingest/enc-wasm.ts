import path from "path";
import initGdalJs = require("gdal3.js/node.js");
import type { CellLayers, ReadCell } from "./cell-reader";
import { readCellLayers } from "./cell-reader";
import type { GeoJsonFeature, GeoJsonFeatureCollection } from "./s57-geojson";
import { POSITION_LAYER, S57_LAYERS } from "./s57-geojson";

/**
 * Reads an S-57 cell straight from its `.000` and update files with GDAL
 * compiled to WebAssembly (gdal3.js): no export step, no container. Each
 * layer the reader uses is converted by ogr2ogr to GeoJSON in gdal3.js's
 * in-memory file system and goes through the same reader as an exported
 * directory, so every parsing rule is shared. The options are those of
 * `scripts/enc-to-geojson.sh`, primitives included for the cell's
 * positional quality. NOAA US5FL61M (1.5 MB, 10 000 features used) reads in
 * 1.7 s at 270 MB RSS; one `ogrinfo -json -features` of every layer took
 * 4.4 s at 510 MB (x86). The WebAssembly memory is never returned to the
 * system, so run this in a worker thread that exits after the build.
 */

const S57_OPTIONS = [
  "RETURN_PRIMITIVES=ON",
  "RETURN_LINKAGES=OFF",
  "LNAM_REFS=ON",
  "UPDATES=APPLY",
  "SPLIT_MULTIPOINT=ON",
  "ADD_SOUNDG_DEPTH=ON"
].join(",");

/** The export script's test for a spatial record whose position is not surveyed. */
const LOW_ACCURACY_WHERE =
  "(QUAPOS IS NOT NULL AND QUAPOS NOT IN (1, 10, 11)) OR POSACC IS NOT NULL";

/**
 * The layers read, with their ogr2ogr options: the object layers the reader parses, the
 * provenance layers, and the primitives QUAPOS is built from. Edges and isolated nodes are
 * filtered in GDAL (Edge on US5FL61M: 736 of 3 352, 147 ms instead of 439); connected nodes
 * are read whole, since the low-accuracy edges' end nodes come along.
 */
const LAYERS: [string, string[]][] = [
  ...["DSID", "M_SDAT", "M_VDAT"].map((l): [string, string[]] => [l, []]),
  ...S57_LAYERS.filter((l) => l !== POSITION_LAYER).map((l): [string, string[]] => [l, []]),
  ["Edge", ["-where", LOW_ACCURACY_WHERE]],
  ["ConnectedNode", []],
  ["IsolatedNode", ["-where", LOW_ACCURACY_WHERE]]
];

type Gdal = Awaited<ReturnType<typeof initGdalJs>>;
type Dataset = Parameters<Gdal["close"]>[0];

let gdal: Promise<Gdal> | undefined;
/** One GDAL call at a time: the WebAssembly instance is single-threaded. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * gdal3.js looks for its `.wasm` and `.data` files under `node_modules/gdal3.js/dist/package/`
 * of the working directory unless given a path, and reads the `.data` file from `./` plus that
 * path, so the package's own directory is passed relative to the working directory.
 */
function gdalJs(): Promise<Gdal> {
  const dist = path.join(path.dirname(require.resolve("gdal3.js/node.js")), "dist", "package");
  gdal ??= initGdalJs({
    path: path.relative(process.cwd(), dist) || ".",
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

/** gdal3.js rejects with GDAL error records, or an array of them; this makes them an Error. */
function gdalError(what: string, err: unknown): Error {
  const records = Array.isArray(err) ? (err as unknown[]) : [err];
  const messages = records.map((r) =>
    r && typeof r === "object" && "message" in r ? String(r.message) : String(r)
  );
  return new Error(`GDAL cannot read ${what}: ${messages.join("; ") || "no dataset"}`);
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

/** One layer as GeoJSON, written to and removed from gdal3.js's in-memory `/output`. */
async function readLayer(
  g: Gdal,
  ds: Dataset,
  layer: string,
  options: string[]
): Promise<GeoJsonFeature[]> {
  const out = await g.ogr2ogr(ds, ["-f", "GeoJSON", ...options, layer], layer);
  try {
    const bytes = g.Module.FS.readFile(out.local);
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    return (JSON.parse(text) as GeoJsonFeatureCollection).features;
  } finally {
    g.Module.FS.unlink(out.local);
  }
}

/** The layers the reader uses, each read once; a layer the cell lacks stays absent. */
async function readLayers(file: string): Promise<CellLayers> {
  const g = await gdalJs();
  const layers = await serial(async () => {
    // Update files beside the base cell are found and applied by the driver (UPDATES=APPLY).
    const { datasets, errors } = await g.open(file).catch((err: unknown) => {
      throw gdalError(file, err);
    });
    const ds = datasets[0];
    if (!ds) {
      throw gdalError(file, errors);
    }
    try {
      // ogr2ogr fails on a layer the cell lacks; open() has listed the cell's layers.
      const present = new Set((ds.info?.layers ?? []).map((l) => l.name));
      const read = new Map<string, GeoJsonFeature[]>();
      for (const [layer, options] of LAYERS) {
        if (present.has(layer)) {
          const features = await readLayer(g, ds, layer, options).catch((err: unknown) => {
            throw gdalError(`${file} layer ${layer}`, err);
          });
          read.set(layer, features);
        }
      }
      return read;
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
