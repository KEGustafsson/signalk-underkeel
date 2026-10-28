import { geomBounds } from "../foundation/geometry";
import type { DepthFeature } from "../ingest/features";

/**
 * The body of `hazards.bin` (`hazard-file.ts`): a little-endian length, the
 * JSON meta, then the point columns and the boxes of the tree over them,
 * each 8-aligned. Points are in Hilbert order, ties in feature order, so the
 * layout depends on the features alone and runs of consecutive points lie
 * close together. The boxes are stored rather than computed at load, which
 * took 30–100 ms of the event loop for the 427 202 Waddenzee points.
 */

/** Position on the Hilbert curve of order 16 of cell (x, y), each in [0, 65535]. */
function hilbert(x: number, y: number): number {
  let d = 0;
  for (let s = 32768; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/** A hazard as JSON holds it: no infinities, so land and dry hazards have depth null. */
type StoredHazard = Omit<DepthFeature, "depth"> & { depth: number | null };

/**
 * A depth as the index holds it: NaN and +∞ read as land, as `hazards.json`
 * saved them, the conservative reading.
 */
const landOr = (depth: number): number => (Number.isFinite(depth) ? depth : -Infinity);

/**
 * How point depths are stored: whole centimetres in 16 or 32 bits, the
 * least value standing for land, when every depth is exactly its centimetre
 * count over 100; otherwise as they are. A depth is never rounded: the
 * naming compares a hazard's depth with a tile's for equality, and a
 * rounded one could read deeper than charted.
 */
export type DepthCode = "cm16" | "cm32" | "f64";

const DEPTH_COLUMN = { cm16: Int16Array, cm32: Int32Array, f64: Float64Array };
export const LAND_CM = { cm16: -32768, cm32: -2147483648 };

function depthCode(depths: Float64Array): DepthCode {
  let code: DepthCode = "cm16";
  for (const d of depths) {
    if (d === -Infinity) {
      continue;
    }
    const cm = Math.round(d * 100);
    if (cm / 100 !== d || Math.abs(cm) > 2147483647) {
      return "f64";
    }
    if (Math.abs(cm) > 32767) {
      code = "cm32";
    }
  }
  return code;
}

/** The narrowest unsigned column holding ids below `count`. */
const idColumn = (count: number) =>
  count <= 256 ? Uint8Array : count <= 65536 ? Uint16Array : Uint32Array;

/** What the body holds besides its columns, as JSON. */
export interface Meta {
  /** Point hazards: the columns' length. */
  points: number;
  /** Entries per node of the trees. */
  nodeSize: number;
  depth: DepthCode;
  /** A point's fields but position and depth, shared: a multipoint sounding's points use one. */
  props: Omit<DepthFeature, "geom" | "depth">[];
  /** Lines and areas, with their feature index. */
  others: { i: number; f: StoredHazard }[];
}

export interface Level {
  /** The level's first node in the boxes column. */
  start: number;
  count: number;
}

/** The point tree's levels, leaves first: runs of `size` points, then of nodes, up to one root. */
export function levelsOf(points: number, size: number): Level[] {
  const levels: Level[] = [];
  for (let below = points, start = 0; below > 0; below = below > 1 ? below : 0) {
    below = Math.ceil(below / size);
    levels.push({ start, count: below });
    start += below;
  }
  return levels;
}

const align = (offset: number): number => Math.ceil(offset / 8) * 8;

/**
 * The columns' byte offsets in a body whose JSON meta is `json` bytes long
 * (x, y, feature index, depth, shared fields, node boxes), each 8-aligned
 * after a 4-byte length and the meta, and the body's length.
 */
function layout(meta: Meta, json: number): { offsets: number[]; end: number } {
  const n = meta.points;
  const nodes = levelsOf(n, meta.nodeSize).reduce((sum, l) => sum + l.count, 0);
  const bytes = [
    8 * n,
    8 * n,
    4 * n,
    DEPTH_COLUMN[meta.depth].BYTES_PER_ELEMENT * n,
    idColumn(meta.props.length).BYTES_PER_ELEMENT * n,
    8 * 4 * nodes
  ];
  const offsets: number[] = [];
  let at = align(4 + json);
  for (const b of bytes) {
    offsets.push(at);
    at = align(at + b);
  }
  return { offsets, end: at };
}

/** The views of `meta`'s columns on `body`, little-endian as written. */
export function columnsOn(body: Uint8Array, meta: Meta, json: number) {
  const { offsets, end } = layout(meta, json);
  const [ox, oy, of, od, op, on] = offsets.map((o) => body.byteOffset + o) as [
    number,
    number,
    number,
    number,
    number,
    number
  ];
  const buffer = body.buffer as ArrayBuffer;
  const n = meta.points;
  return {
    x: new Float64Array(buffer, ox, n),
    y: new Float64Array(buffer, oy, n),
    feature: new Uint32Array(buffer, of, n),
    depth: new DEPTH_COLUMN[meta.depth](buffer, od, n),
    prop: new (idColumn(meta.props.length))(buffer, op, n),
    /** minX, minY, maxX, maxY per node, level by level from the leaves. */
    nodes: new Float64Array(buffer, on, (body.byteOffset + end - on) / 8)
  };
}

/** Each node's box over its run of points or of nodes below. */
function fillNodes(x: Float64Array, y: Float64Array, nodes: Float64Array, size: number): void {
  const levels = levelsOf(x.length, size);
  for (let k = 0; k < (levels[0]?.count ?? 0); k++) {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let r = k * size; r < Math.min(x.length, (k + 1) * size); r++) {
      minX = Math.min(minX, x[r] as number);
      minY = Math.min(minY, y[r] as number);
      maxX = Math.max(maxX, x[r] as number);
      maxY = Math.max(maxY, y[r] as number);
    }
    nodes.set([minX, minY, maxX, maxY], 4 * k);
  }
  for (let l = 1; l < levels.length; l++) {
    const below = levels[l - 1] as Level;
    const { start, count } = levels[l] as Level;
    for (let k = 0; k < count; k++) {
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      const end = below.start + Math.min(below.count, (k + 1) * size);
      for (let c = below.start + k * size; c < end; c++) {
        minX = Math.min(minX, nodes[4 * c] as number);
        minY = Math.min(minY, nodes[4 * c + 1] as number);
        maxX = Math.max(maxX, nodes[4 * c + 2] as number);
        maxY = Math.max(maxY, nodes[4 * c + 3] as number);
      }
      nodes.set([minX, minY, maxX, maxY], 4 * (start + k));
    }
  }
}

/** The body holding `features`, its trees with `nodeSize` entries per node. */
export function encode(features: readonly DepthFeature[], nodeSize: number): Uint8Array {
  const points: { i: number; p: readonly [number, number]; f: DepthFeature }[] = [];
  const others: Meta["others"] = [];
  features.forEach((f, i) => {
    if (f.geom.type === "point") {
      points.push({ i, p: f.geom.p, f });
    } else {
      others.push({ i, f: { ...f, depth: Number.isFinite(f.depth) ? f.depth : null } });
    }
  });
  const bounds = geomBounds({ type: "line", coords: points.map((q) => q.p) });
  const grid = (v: number, min: number, max: number): number =>
    Math.min(65535, Math.max(0, Math.floor(((v - min) / (max - min || 1)) * 65535)));
  const key = points.map(({ p }) =>
    hilbert(grid(p[0], bounds.minX, bounds.maxX), grid(p[1], bounds.minY, bounds.maxY))
  );
  const order = points
    .map((_, j) => j)
    .sort((a, b) => (key[a] as number) - (key[b] as number) || a - b)
    .map((j) => points[j] as (typeof points)[number]);
  const depths = Float64Array.from(order, (q) => landOr(q.f.depth));
  const props: Meta["props"] = [];
  const ids = new Map<string, number>();
  const propOf = order.map(({ f }) => {
    const { geom: _geom, depth: _depth, ...rest } = f;
    const k = JSON.stringify(rest);
    let id = ids.get(k);
    if (id === undefined) {
      id = props.length;
      ids.set(k, id);
      props.push(JSON.parse(k) as Meta["props"][number]);
    }
    return id;
  });
  const meta: Meta = { points: order.length, nodeSize, depth: depthCode(depths), props, others };
  const json = Buffer.from(JSON.stringify(meta), "utf8");
  const body = new Uint8Array(layout(meta, json.length).end);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  const cols = columnsOn(body, meta, json.length);
  const code = meta.depth;
  order.forEach(({ i, p }, r) => {
    const d = depths[r] as number;
    cols.x[r] = p[0];
    cols.y[r] = p[1];
    cols.feature[r] = i;
    cols.depth[r] = code === "f64" ? d : d === -Infinity ? LAND_CM[code] : Math.round(d * 100);
    cols.prop[r] = propOf[r] as number;
  });
  fillNodes(cols.x, cols.y, cols.nodes, nodeSize);
  return body;
}

/** The meta of a body, refusing one whose columns do not fill it exactly. */
export function decodeMeta(body: Uint8Array): { meta: Meta; json: number } {
  if (body.length < 4) {
    throw new Error("hazards file is corrupt (no meta)");
  }
  const json = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
  if (4 + json > body.length) {
    throw new Error("hazards file is corrupt (meta past its end)");
  }
  const meta = JSON.parse(
    Buffer.from(body.buffer, body.byteOffset + 4, json).toString("utf8")
  ) as Meta;
  if (
    !Number.isSafeInteger(meta.points) ||
    meta.points < 0 ||
    !Number.isSafeInteger(meta.nodeSize) ||
    meta.nodeSize < 2 ||
    !Object.hasOwn(DEPTH_COLUMN, meta.depth) ||
    !Array.isArray(meta.props) ||
    !Array.isArray(meta.others) ||
    layout(meta, json).end !== body.length
  ) {
    throw new Error("hazards file is corrupt (its columns do not fill it)");
  }
  return { meta, json };
}
