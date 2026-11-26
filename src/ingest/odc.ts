import fs from "fs";
import type { Bbox } from "./wfs-fetch";
import type { GeoJsonFeature, GeoJsonFeatureCollection, GeoJsonGeometry } from "./s57-geojson";
import type { TileId } from "./mvt-decode";
import { decodeTile } from "./mvt-decode";
import { clipRing, writeCell } from "./wfs";

/**
 * Optional depth source: Open Data Charts (github.com/dirkwa/open-data-charts), vector charts
 * built from open data (national surveys and models, EMODnet, OpenStreetMap) for waters
 * without free official ENC. signalk-charts-provider-simple downloads them as chart sets and
 * offers their tiles in-process (`charts-provider-tiles.ts`); the box service reads the tiles
 * of its box there, and the build process writes them as one cell directory in the GeoJSON
 * layer layout the cell reader parses. The charts are not for navigation, so the cell is
 * marked with `UK_SOURCE` and the index treats it as advisory, like the Traficom WFS cell
 * (plan §4.2): the look-ahead is never `normal` over it, route legs are never `ok` and the
 * overlay never draws `clear`.
 *
 * Its layers already carry S-57 object classes and attributes (`DEPARE` with `DRVAL1`,
 * `SOUNDG` with `DEPTH`, `OBSTRN` with `VALSOU`, `LNDARE`, `UNSARE`, …). Its coverage is the
 * tiles read, as the chart's own coverage gives them; its depths are below the chart datum of
 * each source, which the tiles do not state, so the cell states none and is read as on an
 * unknown datum (plan §4.5).
 */

export const ODC_SOURCE = "open-data-charts";
/** Band 1 (overview), so every ENC cell takes precedence where both cover. */
export const ODC_CELL_NAME = "OD1ODC01";
export const ODC_NOTICE =
  "depths from Open Data Charts: not for navigation; built from open data, no official survey quality";
/**
 * The zoom its tiles are read at. From z15 a unit holds every feature it draws deeper (the
 * soundings thinned per zoom keep the shoalest of each z15 square), its polygons are simplified
 * to well under a metre and none is dropped as tiny; a 10 km box at 50° reads about 700 tiles.
 */
export const ODC_ZOOM = 15;

/** The S-57 layers of a tile the index uses; coverage and quality come from the box. */
export const ODC_LAYERS: ReadonlySet<string> = new Set([
  "DEPARE",
  "DRGARE",
  "SWPARE",
  "SOUNDG",
  "UWTROC",
  "WRECKS",
  "OBSTRN",
  "LNDARE",
  "COALNE",
  "SLCONS",
  "PONTON",
  "FLODOC",
  "HULKES",
  "UNSARE"
]);

/** A tile as Charts Provider served it, and where it lies. */
export interface StagedTile extends TileId {
  data: Uint8Array;
}

/** What one Open Data Charts cell holds. */
export interface OdcCounts {
  tiles: number;
  features: number;
}

const lonOf = (x: number, z: number): number => (x / 2 ** z) * 360 - 180;

function latOf(y: number, z: number): number {
  const m = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (Math.atan(Math.sinh(m)) * 180) / Math.PI;
}

const tileX = (lon: number, z: number): number =>
  Math.min(2 ** z - 1, Math.max(0, Math.floor(((lon + 180) / 360) * 2 ** z)));

function tileY(lat: number, z: number): number {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
  return Math.min(2 ** z - 1, Math.max(0, Math.floor(y)));
}

/** The tile's west, south, east and north. */
export function tileBbox({ z, x, y }: TileId): Bbox {
  return [lonOf(x, z), latOf(y + 1, z), lonOf(x + 1, z), latOf(y, z)];
}

/** Where `a` and `b` overlap, or undefined where they only touch or miss. */
export function intersect(a: Bbox, b: Bbox): Bbox | undefined {
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  return w < e && s < n ? [w, s, e, n] : undefined;
}

/** The z/x/y tiles a chart's `coverage` entries name, as Charts Provider lists them. */
export function coverageTiles(coverage: unknown): TileId[] {
  if (!Array.isArray(coverage)) {
    return [];
  }
  const out: TileId[] = [];
  for (const entry of coverage) {
    const tiles = (entry as { tiles?: unknown } | null)?.tiles;
    if (!Array.isArray(tiles)) {
      continue;
    }
    for (const t of tiles) {
      const m = typeof t === "string" ? /^(\d{1,2})\/(\d{1,10})\/(\d{1,10})$/.exec(t) : null;
      if (m) {
        out.push({ z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) });
      }
    }
  }
  return out;
}

/**
 * The ODC_ZOOM tiles meeting `bbox` that lie in one of `covered`, the tiles a chart fills
 * entirely: only there does a tile read stand for the chart's data. Past them Charts Provider
 * answers a missing tile from its nearest ancestor, a region overview at a smaller scale.
 */
export function tilesToRead(bbox: Bbox, covered: readonly TileId[], z = ODC_ZOOM): TileId[] {
  const byZoom = new Map<number, Set<string>>();
  for (const c of covered) {
    if (c.z <= z) {
      byZoom.set(c.z, (byZoom.get(c.z) ?? new Set()).add(`${c.x}/${c.y}`));
    }
  }
  const inside = (x: number, y: number): boolean =>
    [...byZoom].some(([cz, set]) => set.has(`${x >> (z - cz)}/${y >> (z - cz)}`));
  const out: TileId[] = [];
  const [w, s, e, n] = bbox;
  for (let y = tileY(n, z); y <= tileY(s, z); y++) {
    for (let x = tileX(w, z); x <= tileX(e, z); x++) {
      if (inside(x, y) && intersect(tileBbox({ z, x, y }), bbox)) {
        out.push({ z, x, y });
      }
    }
  }
  return out;
}

/** A staged tile's header: zoom, x, y and the body's length, little-endian. */
const HEADER_BYTES = 13;

/** Appends `tile` to the staging file open as `fd`. */
export function writeStagedTile(fd: number, tile: StagedTile): void {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(tile.z, 0);
  header.writeUInt32LE(tile.x, 1);
  header.writeUInt32LE(tile.y, 5);
  header.writeUInt32LE(tile.data.length, 9);
  fs.writeSync(fd, header);
  fs.writeSync(fd, tile.data);
}

/** The tiles in the staging file `file`, in the order they were written. */
export function readStagedTiles(file: string): StagedTile[] {
  const buf = fs.readFileSync(file);
  const out: StagedTile[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + HEADER_BYTES > buf.length) {
      throw new Error(`${file}: truncated tile header`);
    }
    const length = buf.readUInt32LE(pos + 9);
    const start = pos + HEADER_BYTES;
    if (start + length > buf.length) {
      throw new Error(`${file}: truncated tile`);
    }
    out.push({
      z: buf.readUInt8(pos),
      x: buf.readUInt32LE(pos + 1),
      y: buf.readUInt32LE(pos + 5),
      data: buf.subarray(start, start + length)
    });
    pos = start + length;
  }
  return out;
}

type Position = number[];

/** Liang–Barsky: the part of segment a→b inside `box`, or undefined. */
function clipSegment(
  a: Position,
  b: Position,
  [w, s, e, n]: Bbox
): [Position, Position] | undefined {
  const [ax, ay] = a as [number, number];
  const dx = (b[0] as number) - ax;
  const dy = (b[1] as number) - ay;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, ax - w],
    [dx, e - ax],
    [-dy, ay - s],
    [dy, n - ay]
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) {
        return undefined;
      }
    } else {
      const t = q / p;
      if (p < 0) {
        t0 = Math.max(t0, t);
      } else {
        t1 = Math.min(t1, t);
      }
    }
  }
  if (t0 > t1) {
    return undefined;
  }
  return [
    [ax + t0 * dx, ay + t0 * dy],
    [ax + t1 * dx, ay + t1 * dy]
  ];
}

/** The parts of a line inside `box`, each a line of two or more positions. */
function clipLine(line: Position[], box: Bbox): Position[][] {
  const out: Position[][] = [];
  let current: Position[] | undefined;
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = clipSegment(line[i] as Position, line[i + 1] as Position, box);
    if (!seg) {
      current = undefined;
      continue;
    }
    const [p, q] = seg;
    const last = current?.[current.length - 1];
    if (current && last && last[0] === p[0] && last[1] === p[1]) {
      current.push(q);
    } else {
      current = [p, q];
      out.push(current);
    }
    // A segment cut short at its end leaves the box: the next part starts a new line.
    if (q[0] !== (line[i + 1] as Position)[0] || q[1] !== (line[i + 1] as Position)[1]) {
      current = undefined;
    }
  }
  return out;
}

/** Half open, so a point on the edge two tiles share is kept by one of them. */
const pointIn = (p: Position, [w, s, e, n]: Bbox): boolean =>
  (p[0] as number) >= w && (p[0] as number) < e && (p[1] as number) >= s && (p[1] as number) < n;

/** `g` cut to `box`; null when nothing of it is inside. */
function clipGeometry(g: GeoJsonGeometry, box: Bbox): GeoJsonGeometry | null {
  const c = g.coordinates;
  switch (g.type) {
    case "Point":
      return pointIn(c as Position, box) ? g : null;
    case "MultiPoint": {
      const kept = (c as Position[]).filter((p) => pointIn(p, box));
      return kept.length > 0 ? { type: "MultiPoint", coordinates: kept } : null;
    }
    case "LineString":
    case "MultiLineString": {
      const lines = (g.type === "LineString" ? [c] : c) as Position[][];
      const parts = lines.flatMap((l) => clipLine(l, box));
      return parts.length > 0 ? { type: "MultiLineString", coordinates: parts } : null;
    }
    case "Polygon":
    case "MultiPolygon": {
      const polys = (g.type === "Polygon" ? [c] : c) as Position[][][];
      const parts = polys
        .map((rings) => rings.map((r) => clipRing(r, box)))
        .filter((rings) => (rings[0]?.length ?? 0) > 0)
        .map((rings) => rings.filter((r) => r.length > 0));
      return parts.length > 0 ? { type: "MultiPolygon", coordinates: parts } : null;
    }
    default:
      return null;
  }
}

/** `f`'s geometry cut to `box`; null when nothing of it is inside. */
function clipFeature(f: GeoJsonFeature, box: Bbox): GeoJsonFeature | null {
  const geometry = f.geometry ? clipGeometry(f.geometry, box) : null;
  return geometry ? { type: "Feature", geometry, properties: f.properties } : null;
}

/** The tiles read, merged into one rectangle per run of tiles along each row, cut to `bbox`. */
export function coverageParts(tiles: readonly TileId[], bbox: Bbox): Bbox[] {
  const rows = new Map<string, number[]>();
  for (const t of tiles) {
    const key = `${t.z}/${t.y}`;
    const xs = rows.get(key) ?? [];
    xs.push(t.x);
    rows.set(key, xs);
  }
  const out: Bbox[] = [];
  for (const [key, xs] of rows) {
    const [z, y] = key.split("/").map(Number) as [number, number];
    const sorted = [...new Set(xs)].sort((a, b) => a - b);
    let start = sorted[0] as number;
    for (let i = 1; i <= sorted.length; i++) {
      const x = sorted[i];
      if (x === undefined || x !== (sorted[i - 1] as number) + 1) {
        const run: Bbox = [
          lonOf(start, z),
          latOf(y + 1, z),
          lonOf((sorted[i - 1] as number) + 1, z),
          latOf(y, z)
        ];
        const part = intersect(run, bbox);
        if (part) {
          out.push(part);
        }
        if (x !== undefined) {
          start = x;
        }
      }
    }
  }
  return out;
}

const collection = (features: unknown[]): GeoJsonFeatureCollection =>
  ({ type: "FeatureCollection", features }) as GeoJsonFeatureCollection;

const ring = ([w, s, e, n]: Bbox): number[][][] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s]
  ]
];

/**
 * The cell's GeoJSON layers from `tiles`, each tile's features cut to the tile and `bbox`, so
 * the buffer a tile carries past its edge is read once, from the tile it belongs to. With
 * `catzoc` other than 6 (U) the coverage carries it as an assumed M_QUAL zone, as the
 * Traficom WFS cell does; the tiles state none.
 */
export function odcCellLayers(
  tiles: readonly StagedTile[],
  bbox: Bbox,
  fetchedAt: Date,
  catzoc = 6
): { layers: Record<string, GeoJsonFeatureCollection>; counts: OdcCounts } {
  const byLayer = new Map<string, GeoJsonFeature[]>();
  const read: TileId[] = [];
  let features = 0;
  for (const tile of tiles) {
    const box = intersect(tileBbox(tile), bbox);
    if (!box) {
      continue;
    }
    let decoded: Map<string, GeoJsonFeature[]>;
    try {
      decoded = decodeTile(tile.data, tile, ODC_LAYERS);
    } catch (err) {
      throw new Error(
        `Open Data Charts tile ${tile.z}/${tile.x}/${tile.y}: ${(err as Error).message}`,
        {
          cause: err
        }
      );
    }
    read.push(tile);
    for (const [layer, list] of decoded) {
      const out = byLayer.get(layer) ?? [];
      for (const f of list) {
        const clipped = clipFeature(f, box);
        if (clipped) {
          out.push(clipped);
          features++;
        }
      }
      byLayer.set(layer, out);
    }
  }
  const parts = coverageParts(read, bbox);
  const layers: Record<string, GeoJsonFeatureCollection> = {
    DSID: collection([
      {
        type: "Feature",
        geometry: null,
        properties: {
          DSID_DSNM: `${ODC_CELL_NAME}.000`,
          DSID_EDTN: "1",
          DSID_UPDN: "0",
          DSID_ISDT: fetchedAt.toISOString().slice(0, 10).replace(/-/g, ""),
          UK_SOURCE: ODC_SOURCE
        }
      }
    ]),
    M_COVR: collection(
      parts.map((p, i) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: ring(p) },
        properties: { CATCOV: 1, LNAM: `ODC-COVR-${i}` }
      }))
    ),
    M_QUAL: collection(
      catzoc === 6
        ? []
        : parts.map((p, i) => ({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: ring(p) },
            properties: { CATZOC: catzoc, LNAM: `ODC-QUAL-ASSUMED-${i}` }
          }))
    )
  };
  for (const [layer, list] of byLayer) {
    layers[layer] = collection(list);
  }
  return { layers, counts: { tiles: read.length, features } };
}

/** What the build process needs to write the cell: the staged tiles and where the cell goes. */
export interface OdcCellJob {
  /** The staging file of the tiles read (`writeStagedTile`). */
  tiles: string;
  dir: string;
  bbox: Bbox;
  /** ISO time the tiles were read. */
  now: string;
  catzoc?: number;
}

/** Writes the cell of `job`'s tiles; it holds coverage only where a tile was read. */
export function writeOdcCell(job: OdcCellJob): OdcCounts {
  const { layers, counts } = odcCellLayers(
    readStagedTiles(job.tiles),
    job.bbox,
    new Date(job.now),
    job.catzoc
  );
  writeCell(job.dir, layers);
  return counts;
}
