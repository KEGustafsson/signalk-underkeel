/** Just enough of a protobuf / MVT 2.1 decoder to check what the encoder wrote. */

interface Field {
  field: number;
  wire: number;
  value: number | Uint8Array;
}

function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = buf[i++] as number;
      v += (b & 0x7f) * mul;
      if (b < 0x80) {
        return v;
      }
      mul *= 128;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const wire = key & 7;
    const field = key >>> 3;
    if (wire === 0) {
      out.push({ field, wire, value: varint() });
    } else if (wire === 2) {
      const len = varint();
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  return out;
}

function packed(buf: Uint8Array): number[] {
  const out: number[] = [];
  let v = 0;
  let mul = 1;
  for (const b of buf) {
    v += (b & 0x7f) * mul;
    mul *= 128;
    if (b < 0x80) {
      out.push(v);
      v = 0;
      mul = 1;
    }
  }
  return out;
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const unzig = (n: number): number => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

export interface DecodedFeature {
  type: number;
  properties: Record<string, string>;
  /** Rings as absolute points. */
  rings: [number, number][][];
}

export interface DecodedLayer {
  version: number;
  name: string;
  extent: number;
  features: DecodedFeature[];
}

function decodeGeometry(cmds: number[]): [number, number][][] {
  const rings: [number, number][][] = [];
  let ring: [number, number][] = [];
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++] as number;
    const id = c & 7;
    const count = c >> 3;
    if (id === 7) {
      rings.push(ring);
      ring = [];
      continue;
    }
    for (let k = 0; k < count; k++) {
      x += unzig(cmds[i++] as number);
      y += unzig(cmds[i++] as number);
      ring.push([x, y]);
    }
  }
  return rings;
}

export function decodeMvt(tile: Uint8Array): DecodedLayer[] {
  return fields(tile)
    .filter((f) => f.field === 3)
    .map((lf) => {
      const lfs = fields(lf.value as Uint8Array);
      const keys = lfs.filter((f) => f.field === 3).map((f) => text(f.value as Uint8Array));
      const values = lfs
        .filter((f) => f.field === 4)
        .map((f) => text(fields(f.value as Uint8Array)[0]?.value as Uint8Array));
      const features = lfs
        .filter((f) => f.field === 2)
        .map((ff) => {
          const parts = fields(ff.value as Uint8Array);
          const tags = packed(parts.find((p) => p.field === 2)?.value as Uint8Array);
          const properties: Record<string, string> = {};
          for (let k = 0; k < tags.length; k += 2) {
            properties[keys[tags[k] as number] as string] = values[tags[k + 1] as number] as string;
          }
          return {
            type: parts.find((p) => p.field === 3)?.value as number,
            properties,
            rings: decodeGeometry(packed(parts.find((p) => p.field === 4)?.value as Uint8Array))
          };
        });
      return {
        version: lfs.find((f) => f.field === 15)?.value as number,
        name: text(lfs.find((f) => f.field === 1)?.value as Uint8Array),
        extent: lfs.find((f) => f.field === 5)?.value as number,
        features
      };
    });
}
