import { gunzipSync } from "zlib";
import type { GeoJsonFeature, GeoJsonGeometry } from "./s57-geojson";

/**
 * Mapbox Vector Tile 2.1 decoder: the features of a tile's layers as GeoJSON in longitude and
 * latitude, as the Open Data Charts tiles (`odc.ts`) are read. A gzipped tile, as MBTiles keep
 * them, is unzipped first. Geometry is not clipped: tiles carry a buffer past their edge.
 */

/** The tile a body belongs to, XYZ with y from the north. */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;

const GEOM_POINT = 1;
const GEOM_LINE = 2;
const GEOM_POLYGON = 3;

const DEFAULT_EXTENT = 4096;

class Reader {
  pos = 0;

  constructor(
    private readonly buf: Uint8Array,
    readonly end = buf.length
  ) {}

  /** Up to 2^53: tile ids and coordinates never come near it. */
  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (this.pos >= this.end) {
        throw new Error("vector tile: truncated varint");
      }
      const b = this.buf[this.pos++] as number;
      value += (b & 0x7f) * scale;
      if (b < 0x80) {
        return value;
      }
      scale *= 128;
      if (scale > 2 ** 56) {
        throw new Error("vector tile: varint too long");
      }
    }
  }

  /** A two's-complement int64 varint, as `int_value` holds a negative number. */
  int64(): number {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) {
        throw new Error("vector tile: truncated varint");
      }
      const b = this.buf[this.pos++] as number;
      value |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) {
        return Number(BigInt.asIntN(64, value));
      }
      shift += 7n;
      if (shift > 63n) {
        throw new Error("vector tile: varint too long");
      }
    }
  }

  /** A length-delimited field's bytes, as a reader of their own. */
  sub(): Reader {
    const length = this.varint();
    const start = this.pos;
    if (start + length > this.end) {
      throw new Error("vector tile: field past the end of its message");
    }
    this.pos += length;
    const r = new Reader(this.buf, start + length);
    r.pos = start;
    return r;
  }

  string(): string {
    const r = this.sub();
    return new TextDecoder().decode(this.buf.subarray(r.pos, r.end));
  }

  /** A packed field's values, appended to `out`: a repeated field may come in several parts. */
  packed(out: number[] = []): number[] {
    const r = this.sub();
    while (r.pos < r.end) {
      out.push(r.varint());
    }
    return out;
  }

  fixed32Float(): number {
    this.within(4);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  fixed64Double(): number {
    this.within(8);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  private within(bytes: number): void {
    if (this.pos + bytes > this.end) {
      throw new Error("vector tile: value past the end of its message");
    }
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.within(8);
        this.pos += 8;
        return;
      case WIRE_BYTES:
        this.sub();
        return;
      case WIRE_FIXED32:
        this.within(4);
        this.pos += 4;
        return;
      default:
        throw new Error(`vector tile: unsupported wire type ${wire}`);
    }
  }

  get more(): boolean {
    return this.pos < this.end;
  }
}

const unzigzag = (n: number): number => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

/** The readers of a `Value`'s fields, by tag (field × 8 + wire type). */
const VALUE_READERS: ReadonlyMap<number, (r: Reader) => unknown> = new Map<
  number,
  (r: Reader) => unknown
>([
  [1 * 8 + WIRE_BYTES, (r: Reader) => r.string()],
  [2 * 8 + WIRE_FIXED32, (r: Reader) => r.fixed32Float()],
  [3 * 8 + WIRE_FIXED64, (r: Reader) => r.fixed64Double()],
  [4 * 8 + WIRE_VARINT, (r: Reader) => r.int64()],
  [5 * 8 + WIRE_VARINT, (r: Reader) => r.varint()],
  [6 * 8 + WIRE_VARINT, (r: Reader) => unzigzag(r.varint())],
  [7 * 8 + WIRE_VARINT, (r: Reader) => r.varint() !== 0]
]);

function readValue(r: Reader): unknown {
  let value: unknown;
  while (r.more) {
    const tag = r.varint();
    const read = VALUE_READERS.get(tag);
    if (read) {
      value = read(r);
    } else {
      r.skip(tag % 8);
    }
  }
  return value;
}

interface RawFeature {
  tags: number[];
  type: number;
  geometry: number[];
}

function readFeature(r: Reader): RawFeature {
  const f: RawFeature = { tags: [], type: 0, geometry: [] };
  while (r.more) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 2 && wire === WIRE_BYTES) {
      r.packed(f.tags);
    } else if (field === 3 && wire === WIRE_VARINT) {
      f.type = r.varint();
    } else if (field === 4 && wire === WIRE_BYTES) {
      r.packed(f.geometry);
    } else {
      r.skip(wire);
    }
  }
  return f;
}

/** Paths of tile coordinates: each MoveTo starts one; a polygon's are closed by ClosePath. */
function paths(geometry: readonly number[]): [number, number][][] {
  const out: [number, number][][] = [];
  let current: [number, number][] | undefined;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < geometry.length) {
    const c = geometry[i++] as number;
    const id = c & 0x7;
    const count = c >> 3;
    if (id === CLOSE_PATH) {
      if (current && current.length > 0) {
        current.push(current[0] as [number, number]);
      }
      continue;
    }
    if (id !== MOVE_TO && id !== LINE_TO) {
      throw new Error(`vector tile: unknown geometry command ${id}`);
    }
    for (let k = 0; k < count; k++) {
      const dx = geometry[i++];
      const dy = geometry[i++];
      if (dx === undefined || dy === undefined) {
        throw new Error("vector tile: geometry ends inside a command");
      }
      x += unzigzag(dx);
      y += unzigzag(dy);
      if (id === MOVE_TO) {
        current = [];
        out.push(current);
      }
      current?.push([x, y]);
    }
  }
  return out;
}

/** Twice the surveyor's-formula area in tile coordinates: positive for an exterior ring. */
function ringArea(ring: readonly [number, number][]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x1, y1] = ring[i] as [number, number];
    const [x2, y2] = ring[i + 1] as [number, number];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/** Tile coordinates of `id` to longitude and latitude. */
function toLonLat(id: TileId, extent: number): (p: [number, number]) => [number, number] {
  const n = 2 ** id.z;
  return ([px, py]) => {
    const lon = ((id.x + px / extent) / n) * 360 - 180;
    const m = Math.PI - (2 * Math.PI * (id.y + py / extent)) / n;
    const lat = (Math.atan(Math.sinh(m)) * 180) / Math.PI;
    return [lon, lat];
  };
}

function geometryOf(
  f: RawFeature,
  lonLat: (p: [number, number]) => [number, number]
): GeoJsonGeometry | null {
  const ps = paths(f.geometry);
  switch (f.type) {
    case GEOM_POINT: {
      const points = ps.flat().map(lonLat);
      if (points.length === 0) {
        return null;
      }
      return points.length === 1
        ? { type: "Point", coordinates: points[0] }
        : { type: "MultiPoint", coordinates: points };
    }
    case GEOM_LINE: {
      const lines = ps.filter((l) => l.length >= 2).map((l) => l.map(lonLat));
      if (lines.length === 0) {
        return null;
      }
      return lines.length === 1
        ? { type: "LineString", coordinates: lines[0] }
        : { type: "MultiLineString", coordinates: lines };
    }
    case GEOM_POLYGON: {
      const polygons: [number, number][][][] = [];
      for (const ring of ps) {
        if (ring.length < 4) {
          continue;
        }
        const area = ringArea(ring);
        if (area > 0) {
          polygons.push([ring.map(lonLat)]);
        } else if (area < 0) {
          // A hole before any exterior ring is malformed and dropped with it.
          polygons[polygons.length - 1]?.push(ring.map(lonLat));
        }
      }
      if (polygons.length === 0) {
        return null;
      }
      return polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons };
    }
    default:
      return null;
  }
}

interface RawLayer {
  name: string;
  raw: RawFeature[];
  keys: string[];
  values: unknown[];
  extent: number;
}

function readRawLayer(r: Reader): RawLayer {
  const layer: RawLayer = { name: "", raw: [], keys: [], values: [], extent: DEFAULT_EXTENT };
  while (r.more) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === WIRE_BYTES) {
      layer.name = r.string();
    } else if (field === 2 && wire === WIRE_BYTES) {
      layer.raw.push(readFeature(r.sub()));
    } else if (field === 3 && wire === WIRE_BYTES) {
      layer.keys.push(r.string());
    } else if (field === 4 && wire === WIRE_BYTES) {
      layer.values.push(readValue(r.sub()));
    } else if (field === 5 && wire === WIRE_VARINT) {
      layer.extent = r.varint();
    } else {
      r.skip(wire);
    }
  }
  return layer;
}

function propertiesOf(f: RawFeature, layer: RawLayer): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i + 1 < f.tags.length; i += 2) {
    const key = layer.keys[f.tags[i] as number];
    if (key !== undefined) {
      properties[key] = layer.values[f.tags[i + 1] as number];
    }
  }
  return properties;
}

function readLayer(
  r: Reader,
  id: TileId,
  wanted: ReadonlySet<string> | undefined
): { name: string; features: GeoJsonFeature[] } | undefined {
  const layer = readRawLayer(r);
  if (wanted && !wanted.has(layer.name)) {
    return undefined;
  }
  if (!(layer.extent > 0)) {
    throw new Error(`vector tile: layer ${layer.name} has extent ${layer.extent}`);
  }
  const lonLat = toLonLat(id, layer.extent);
  const features: GeoJsonFeature[] = [];
  for (const f of layer.raw) {
    const geometry = geometryOf(f, lonLat);
    if (geometry) {
      features.push({ type: "Feature", geometry, properties: propertiesOf(f, layer) });
    }
  }
  return { name: layer.name, features };
}

const isGzip = (data: Uint8Array): boolean => data[0] === 0x1f && data[1] === 0x8b;

/**
 * The features of the tile `data` at `id`, by layer, of the `wanted` layers or every one. Throws
 * on a body that is not a vector tile.
 */
export function decodeTile(
  data: Uint8Array,
  id: TileId,
  wanted?: ReadonlySet<string>
): Map<string, GeoJsonFeature[]> {
  const buf = isGzip(data) ? new Uint8Array(gunzipSync(data)) : data;
  const r = new Reader(buf);
  const layers = new Map<string, GeoJsonFeature[]>();
  while (r.more) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 3 && wire === WIRE_BYTES) {
      const layer = readLayer(r.sub(), id, wanted);
      if (layer) {
        const list = layers.get(layer.name) ?? [];
        for (const f of layer.features) {
          list.push(f);
        }
        layers.set(layer.name, list);
      }
    } else {
      r.skip(wire);
    }
  }
  return layers;
}
