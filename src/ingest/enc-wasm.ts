import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import initGdalJs = require("gdal3.js/node.js");
import type { CellLayers, ReadCell } from "./cell-reader";
import { readCellLayers } from "./cell-reader";
import type { GeoJsonFeature, GeoJsonFeatureCollection } from "./s57-geojson";
import { POSITION_LAYER, S57_LAYERS } from "./s57-geojson";

/**
 * Reads an S-57 cell straight from its `.000` and update files with GDAL
 * compiled to WebAssembly (gdal3.js): no export step, no container, nothing
 * written. Each layer the reader uses is converted by ogr2ogr to GeoJSON in
 * gdal3.js's in-memory file system and parsed by the same rules as the
 * plugin's own GeoJSON cells, primitives included for the cell's positional
 * quality. NOAA US5FL61M (1.5 MB, 10 000 features used) reads in
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

/** One layer as GeoJSON bytes, written to and removed from gdal3.js's in-memory `/output`. */
async function readLayer(g: Gdal, ds: Dataset, layer: string, options: string[]): Promise<Buffer> {
  const out = await g.ogr2ogr(ds, ["-f", "GeoJSON", ...options, layer], layer);
  try {
    return Buffer.from(g.Module.FS.readFile(out.local));
  } finally {
    g.Module.FS.unlink(out.local);
  }
}

const PRIMITIVES = new Set(["Edge", "ConnectedNode", "IsolatedNode"]);

/**
 * A cell's layers as GeoJSON bytes by S-57 name, QUAPOS among them: one
 * SharedArrayBuffer per cell, so the index build's region threads read the
 * same bytes without a copy.
 */
export type EncLayers = Record<string, Uint8Array>;

/**
 * The cell's file stamp, kept with its layers. It is taken before GDAL opens
 * the cell, so an update added during the read leaves a stamp that differs.
 */
const STAMP_LAYER = "_files";

const text = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");

const parse = (bytes: Uint8Array): GeoJsonFeatureCollection =>
  JSON.parse(text(bytes)) as GeoJsonFeatureCollection;

function shared(parts: Map<string, Uint8Array>): EncLayers {
  let size = 0;
  parts.forEach((b) => (size += b.byteLength));
  const buffer = new SharedArrayBuffer(size);
  const out: EncLayers = {};
  let at = 0;
  for (const [layer, b] of parts) {
    const view = new Uint8Array(buffer, at, b.byteLength);
    view.set(b);
    out[layer] = view;
    at += b.byteLength;
  }
  return out;
}

/** The layers the index reads from a `.000` cell and its updates, each read once. */
export async function readEncLayers(file: string): Promise<EncLayers> {
  const g = await gdalJs();
  const read = await serial(async () => {
    const stamp = encStamp(file);
    // Update files beside the base cell are found and applied by the driver (UPDATES=APPLY).
    // gdal3.js mounts the cell's folder, and Emscripten's NODEFS cannot mount a symlink.
    const { datasets, errors } = await g.open(fs.realpathSync(file)).catch((err: unknown) => {
      throw gdalError(file, err);
    });
    const ds = datasets[0];
    if (!ds) {
      throw gdalError(file, errors);
    }
    try {
      // ogr2ogr fails on a layer the cell lacks; open() has listed the cell's layers.
      const present = new Set((ds.info?.layers ?? []).map((l) => l.name));
      const out = new Map<string, Buffer>();
      for (const [layer, options] of LAYERS) {
        if (present.has(layer)) {
          const bytes = await readLayer(g, ds, layer, options).catch((err: unknown) => {
            throw gdalError(`${file} layer ${layer}`, err);
          });
          out.set(layer, bytes);
        }
      }
      out.set(STAMP_LAYER, Buffer.from(stamp));
      return out;
    } finally {
      await g.close(ds);
    }
  });
  const primitives = new Map<string, GeoJsonFeature[]>();
  const parts = new Map<string, Uint8Array>();
  for (const [layer, bytes] of read) {
    if (PRIMITIVES.has(layer)) {
      primitives.set(layer, parse(bytes).features);
    } else {
      parts.set(layer, bytes);
    }
  }
  parts.set(POSITION_LAYER, Buffer.from(JSON.stringify(positionLayer(primitives))));
  return shared(parts);
}

/**
 * The edition number in the base cell's DSID record, read from the ISO 8211
 * file itself. GDAL reports the last update's DSID_EDTN once updates are
 * applied, and NOAA updates carry 0 there: US5FL65M, edition 38, read as
 * edition 0 with its three updates.
 */
export function baseEdition(file: string): number | undefined {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(65_536);
    const size = fs.readSync(fd, head, 0, head.length, 0);
    const num = (at: number, len: number): number => Number(head.toString("latin1", at, at + len));
    // The data descriptive record comes first; the DSID is in the first data record after it.
    const dr = num(0, 5);
    if (!(dr > 0) || dr + 24 > size) {
      return undefined;
    }
    const base = dr + num(dr + 12, 5);
    const [lenSize, posSize, tagSize] = [num(dr + 20, 1), num(dr + 21, 1), num(dr + 23, 1)];
    for (let e = dr + 24; head[e] !== 0x1e && e < base; e += tagSize + lenSize + posSize) {
      if (head.toString("latin1", e, e + tagSize) === "DSID") {
        // RCNM (1 byte), RCID (4), EXPP (1), INTU (1), then DSNM and EDTN, each ended by 0x1f.
        const dsnm = base + num(e + tagSize + lenSize, posSize) + 7;
        const edtn = head.indexOf(0x1f, dsnm) + 1;
        const end = head.indexOf(0x1f, edtn);
        const n = edtn > 0 && end > edtn ? Number(head.toString("latin1", edtn, end)) : NaN;
        return Number.isInteger(n) && n > 0 ? n : undefined;
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** The cell `readEncLayers` read from `file`, parsed as `readCellDirectory` parses an export. */
export function encCell(
  file: string,
  layers: EncLayers,
  cellRef: number,
  bandOverride?: number
): ReadCell {
  const name = path.basename(file, path.extname(file));
  const byName: CellLayers = (layer) => {
    const bytes = layers[layer];
    return bytes && parse(bytes);
  };
  const cell = readCellLayers(byName, name, cellRef, bandOverride, file);
  const edition = cell.info.update > 0 ? baseEdition(file) : undefined;
  const stamp = layers[STAMP_LAYER];
  return {
    ...cell,
    // Named by its file, as discovery and the saved index's check name it, whatever DSID_DSNM says.
    info: {
      ...cell.info,
      name,
      edition: edition ?? cell.info.edition,
      files: stamp ? text(stamp) : encStamp(file)
    }
  };
}

/** A cell read from its `.000` and updates. */
export async function readEncCell(
  file: string,
  cellRef: number,
  bandOverride?: number
): Promise<ReadCell> {
  return encCell(file, await readEncLayers(file), cellRef, bandOverride);
}

/**
 * The base cell and its updates (`.001`, `.002`, …) beside it, in order. A
 * linked `.000` has its updates beside the link's target, where GDAL reads them.
 */
export function encFiles(file: string): string[] {
  const dir = path.dirname(fs.realpathSync(file));
  const base = path.basename(file, path.extname(file));
  const updates = fs
    .readdirSync(dir)
    .filter(
      (f) => path.basename(f, path.extname(f)) === base && /^\.(?!000)\d{3}$/.test(path.extname(f))
    )
    .sort();
  return [file, ...updates.map((f) => path.join(dir, f))];
}

/**
 * The names, sizes and modification times of a cell's files, hashed: a new
 * edition, an update added or a file replaced changes it, without reading the cell.
 */
export function encStamp(file: string): string {
  const hash = createHash("sha256");
  for (const f of encFiles(file)) {
    const st = fs.statSync(f);
    hash.update(`${path.basename(f)} ${st.size} ${st.mtimeMs}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}
