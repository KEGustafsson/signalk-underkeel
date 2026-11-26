import type { TileId } from "../../src/ingest/mvt-decode";

/**
 * A Mapbox Vector Tile 2.1 encoder for tests: layers of points, lines and polygons given in
 * longitude and latitude, as tippecanoe writes the Open Data Charts tiles. Numbers that are
 * whole go out as uint or sint values, others as doubles; strings and booleans as such.
 */

export type LonLatPoint = [number, number];

export type TestFeature =
  | { point: LonLatPoint[]; properties?: Record<string, unknown> }
  | { line: LonLatPoint[][]; properties?: Record<string, unknown> }
  /** Each polygon's rings, exterior first, any winding: the encoder winds them. */
  | { polygon: LonLatPoint[][][]; properties?: Record<string, unknown> };

export const TEST_EXTENT = 4096;

class Writer {
  private readonly bytes: number[] = [];

  varint(v: number): this {
    let n = v;
    while (n >= 0x80) {
      this.bytes.push((n % 128) | 0x80);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  raw(data: Uint8Array): this {
    for (const b of data) {
      this.bytes.push(b);
    }
    return this;
  }

  bytesField(field: number, data: Uint8Array): this {
    return this.tag(field, 2).varint(data.length).raw(data);
  }

  string(field: number, s: string): this {
    return this.bytesField(field, new TextEncoder().encode(s));
  }

  packed(field: number, values: number[]): this {
    const w = new Writer();
    values.forEach((v) => w.varint(v));
    return this.bytesField(field, w.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const zigzag = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n);
const command = (id: number, count: number): number => (count << 3) | id;

/** Longitude and latitude to `id`'s tile coordinates, y down. */
export function toTile(id: TileId, [lon, lat]: LonLatPoint): [number, number] {
  const n = 2 ** id.z;
  const x = ((lon + 180) / 360) * n - id.x;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - id.y;
  return [Math.round(x * TEST_EXTENT), Math.round(y * TEST_EXTENT)];
}

function area(ring: readonly [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i] as [number, number];
    const [x2, y2] = ring[(i + 1) % ring.length] as [number, number];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

function geometry(paths: [number, number][][], close: boolean): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const move = ([x, y]: [number, number]): void => {
    out.push(zigzag(x - cx), zigzag(y - cy));
    cx = x;
    cy = y;
  };
  for (const p of paths) {
    const [first, ...rest] = p;
    if (!first) {
      continue;
    }
    out.push(command(1, 1));
    move(first);
    if (rest.length > 0) {
      out.push(command(2, rest.length));
      rest.forEach(move);
    }
    if (close) {
      out.push(command(7, 1));
    }
  }
  return out;
}

function encoded(id: TileId, f: TestFeature): { type: number; geom: number[] } {
  const tile = (p: LonLatPoint): [number, number] => toTile(id, p);
  if ("point" in f) {
    const pts = f.point.map(tile);
    const out: number[] = [command(1, pts.length)];
    let cx = 0;
    let cy = 0;
    for (const [x, y] of pts) {
      out.push(zigzag(x - cx), zigzag(y - cy));
      cx = x;
      cy = y;
    }
    return { type: 1, geom: out };
  }
  if ("line" in f) {
    return {
      type: 2,
      geom: geometry(
        f.line.map((l) => l.map(tile)),
        false
      )
    };
  }
  const rings = f.polygon.flatMap((rs) =>
    rs.map((r, i) => {
      const open = r.map(tile).slice(0, -1);
      // Exterior rings positive by the surveyor's formula in tile coordinates, holes negative.
      return area(open) > 0 === (i === 0) ? open : open.reverse();
    })
  );
  return { type: 3, geom: geometry(rings, true) };
}

function value(v: unknown): Uint8Array {
  const w = new Writer();
  if (typeof v === "string") {
    w.string(1, v);
  } else if (typeof v === "boolean") {
    w.tag(7, 0).varint(v ? 1 : 0);
  } else if (typeof v === "number" && Number.isInteger(v)) {
    if (v >= 0) {
      w.tag(5, 0).varint(v);
    } else {
      w.tag(6, 0).varint(zigzag(v));
    }
  } else {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(Number(v));
    w.tag(3, 1).raw(b);
  }
  return w.finish();
}

/** The tile `id` holding `layers`. */
export function encodeTile(id: TileId, layers: Record<string, TestFeature[]>): Uint8Array {
  const tile = new Writer();
  for (const [name, features] of Object.entries(layers)) {
    const keys: string[] = [];
    const values: unknown[] = [];
    const index = (list: unknown[], v: unknown): number => {
      const i = list.indexOf(v);
      return i >= 0 ? i : list.push(v) - 1;
    };
    const l = new Writer().tag(15, 0).varint(2).string(1, name);
    for (const f of features) {
      const { type, geom } = encoded(id, f);
      const tags = Object.entries(f.properties ?? {}).flatMap(([k, v]) => [
        index(keys, k),
        index(values, v)
      ]);
      l.bytesField(2, new Writer().packed(2, tags).tag(3, 0).varint(type).packed(4, geom).finish());
    }
    keys.forEach((k) => l.string(3, k));
    values.forEach((v) => l.bytesField(4, value(v)));
    l.tag(5, 0).varint(TEST_EXTENT);
    tile.bytesField(3, l.finish());
  }
  return tile.finish();
}
