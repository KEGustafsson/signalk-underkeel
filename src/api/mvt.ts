/**
 * Minimal Mapbox Vector Tile 2.1 encoder: one layer of polygon features
 * with string properties. Enough for the UKC overlay without a protobuf
 * dependency on Pi-class hardware.
 */

/** [x, y] in tile extent units, y down. */
export type TilePoint = readonly [number, number];

export interface MvtFeature {
  /** Closed rings without the repeated first point; exterior rings clockwise (y down). */
  rings: TilePoint[][];
  properties: Record<string, string>;
}

export const MVT_EXTENT = 4096;

class Writer {
  private readonly bytes: number[] = [];

  varint(v: number): this {
    let n = v;
    while (n >= 0x80) {
      this.bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  bytesField(field: number, data: Uint8Array): this {
    this.tag(field, 2).varint(data.length);
    for (const b of data) {
      this.bytes.push(b);
    }
    return this;
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

function geometry(rings: TilePoint[][]): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const ring of rings) {
    const [first, ...rest] = ring;
    if (!first || rest.length < 2) {
      continue;
    }
    out.push(command(1, 1), zigzag(first[0] - cx), zigzag(first[1] - cy));
    [cx, cy] = first;
    out.push(command(2, rest.length));
    for (const [x, y] of rest) {
      out.push(zigzag(x - cx), zigzag(y - cy));
      cx = x;
      cy = y;
    }
    out.push(command(7, 1));
  }
  return out;
}

/** Encodes one layer; an empty feature list still yields a valid tile. */
export function encodeMvt(layer: string, features: MvtFeature[]): Uint8Array {
  const keys: string[] = [];
  const values: string[] = [];
  const index = (list: string[], v: string): number => {
    const i = list.indexOf(v);
    return i >= 0 ? i : list.push(v) - 1;
  };
  const l = new Writer().tag(15, 0).varint(2).string(1, layer);
  for (const f of features) {
    const geom = geometry(f.rings);
    if (geom.length === 0) {
      continue;
    }
    const tags = Object.entries(f.properties).flatMap(([k, v]) => [
      index(keys, k),
      index(values, v)
    ]);
    const fw = new Writer().packed(2, tags).tag(3, 0).varint(3).packed(4, geom);
    l.bytesField(2, fw.finish());
  }
  keys.forEach((k) => l.string(3, k));
  values.forEach((v) => l.bytesField(4, new Writer().string(1, v).finish()));
  l.tag(5, 0).varint(MVT_EXTENT);
  return new Writer().bytesField(3, l.finish()).finish();
}
