import type { Rect } from "../foundation/geo";
import { expandRect, shiftRect, worldShifts } from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { geomBounds, geomRectDistance, shiftGeom } from "../foundation/geometry";
import type { DepthFeature } from "../ingest/features";
import type { DepthCode, Level, Meta } from "./hazard-columns";
import { columnsOn, decodeMeta, encode, LAND_CM, levelsOf } from "./hazard-columns";

/**
 * Named hazards in columns on one buffer, the body of `hazards.bin`
 * (`hazard-columns.ts`): the pyramid already burns them in; the index names
 * the hazard behind a result. Points, 427 202 of the 427 385 Waddenzee
 * hazards, are kept in Hilbert order as position, depth, feature index and
 * a shared entry for their other fields; a static tree over runs of
 * consecutive points finds them. Lines and areas keep their geometry in an
 * STR-packed tree. The Waddenzee hazards take 11 MB this way; as one object
 * per hazard they held 211 MB.
 */

/** Groups `items` (indices into `boxes`) into runs of at most `size`, tiled by x then y. */
function strOrder(items: Uint32Array, boxes: Float64Array, size: number): Uint32Array {
  const cx = (i: number) => (boxes[4 * i] as number) + (boxes[4 * i + 2] as number);
  const cy = (i: number) => (boxes[4 * i + 1] as number) + (boxes[4 * i + 3] as number);
  const slices = Math.ceil(Math.sqrt(Math.ceil(items.length / size)));
  const perSlice = slices * size;
  const byX = items.slice().sort((a, b) => cx(a) - cx(b));
  for (let i = 0; i < byX.length; i += perSlice) {
    byX.subarray(i, i + perSlice).sort((a, b) => cy(a) - cy(b));
  }
  return byX;
}

interface Packed {
  /** minX, minY, maxX, maxY per entry: the hazards first, then each level of nodes. */
  boxes: Float64Array;
  /** Per entry: the hazard's index, or a node's first child entry. */
  first: Uint32Array;
  /** Per entry: a node's child count; 0 for a hazard. */
  children: Uint32Array;
  root: number;
}

/** Widens node `node`'s box over its children's. */
function enclose(boxes: Float64Array, node: number, from: number, count: number): void {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let c = from; c < from + count; c++) {
    minX = Math.min(minX, boxes[4 * c] as number);
    minY = Math.min(minY, boxes[4 * c + 1] as number);
    maxX = Math.max(maxX, boxes[4 * c + 2] as number);
    maxY = Math.max(maxY, boxes[4 * c + 3] as number);
  }
  boxes.set([minX, minY, maxX, maxY], 4 * node);
}

/**
 * The hazards in STR order, then levels of nodes over runs of `size`
 * consecutive entries of the level below, up to one root.
 */
function pack(rects: Float64Array, n: number, size: number): Packed {
  const sizes = [n];
  while ((sizes[sizes.length - 1] as number) > 1) {
    sizes.push(Math.ceil((sizes[sizes.length - 1] as number) / size));
  }
  const entries = sizes.reduce((a, b) => a + b, 0);
  const boxes = new Float64Array(4 * entries);
  const first = new Uint32Array(entries);
  const children = new Uint32Array(entries);
  strOrder(
    Uint32Array.from({ length: n }, (_, i) => i),
    rects,
    size
  ).forEach((f, j) => {
    boxes.set(rects.subarray(4 * f, 4 * f + 4), 4 * j);
    first[j] = f;
  });
  let base = 0;
  for (const [level, below] of sizes.slice(0, -1).entries()) {
    const above = base + below;
    for (let k = 0; k < (sizes[level + 1] as number); k++) {
      const from = base + k * size;
      const count = Math.min(size, below - k * size);
      first[above + k] = from;
      children[above + k] = count;
      enclose(boxes, above + k, from, count);
    }
    base = above;
  }
  return { boxes, first, children, root: entries - 1 };
}

const overlaps = (b: Float64Array, e: number, r: Rect): boolean =>
  (b[4 * e] as number) <= r.maxX &&
  r.minX <= (b[4 * e + 2] as number) &&
  (b[4 * e + 1] as number) <= r.maxY &&
  r.minY <= (b[4 * e + 3] as number);

/** Hazards of `t` whose box overlaps `rect`, as indices into the packed set. */
function searchPacked(t: Packed, rect: Rect, out: number[]): void {
  const stack = [t.root];
  while (stack.length > 0) {
    const e = stack.pop() as number;
    if (!overlaps(t.boxes, e, rect)) {
      continue;
    }
    const count = t.children[e] as number;
    if (count === 0) {
      out.push(t.first[e] as number);
    }
    for (let c = t.first[e] as number; count > 0 && c < (t.first[e] as number) + count; c++) {
      stack.push(c);
    }
  }
}

export interface HazardHit {
  feature: DepthFeature;
  /** Mercator distance from the query geometry (0 when touching). */
  distance: number;
}

/**
 * Hazards from a feature list, the trees with `nodeSize` entries per node,
 * or from a `hazards.bin` body, which names its own.
 */
export class HazardIndex {
  /** The `hazards.bin` body the point columns view. */
  readonly body: Uint8Array;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  /** Per point: its index in the feature list, which orders ties. */
  private readonly feature: Uint32Array;
  private readonly depths: Int16Array | Int32Array | Float64Array;
  private readonly code: DepthCode;
  private readonly prop: Uint8Array | Uint16Array | Uint32Array;
  private readonly props: Meta["props"];
  private readonly others: { i: number; f: DepthFeature }[];
  /** minX, minY, maxX, maxY per line or area. */
  private readonly otherBoxes: Float64Array;
  private readonly otherTree: Packed | undefined;
  private readonly nodeSize: number;
  /** Boxes of the point tree's nodes, the leaves' level first, up to one root. */
  private readonly nodes: Float64Array;
  private readonly levels: Level[];
  /** Scratch for a hazard's box, handed to the distance test. */
  private readonly box: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(source: readonly DepthFeature[] | Uint8Array, nodeSize = 16) {
    const body = source instanceof Uint8Array ? source : encode(source, nodeSize);
    // Float64 views need an 8-aligned start; a copy gives one.
    this.body = body.byteOffset % 8 === 0 ? body : new Uint8Array(body);
    const { meta, json } = decodeMeta(this.body);
    const cols = columnsOn(this.body, meta, json);
    this.x = cols.x;
    this.y = cols.y;
    this.feature = cols.feature;
    this.depths = cols.depth;
    this.code = meta.depth;
    this.prop = cols.prop;
    this.props = meta.props;
    this.nodeSize = meta.nodeSize;
    this.nodes = cols.nodes;
    this.levels = levelsOf(meta.points, meta.nodeSize);
    this.others = meta.others.map(({ i, f }) => ({ i, f: { ...f, depth: f.depth ?? -Infinity } }));
    this.otherBoxes = new Float64Array(4 * this.others.length);
    this.others.forEach(({ f }, k) => {
      const r = geomBounds(f.geom);
      this.otherBoxes.set([r.minX, r.minY, r.maxX, r.maxY], 4 * k);
    });
    this.otherTree =
      this.others.length === 0
        ? undefined
        : pack(this.otherBoxes, this.others.length, meta.nodeSize);
  }

  get size(): number {
    return this.x.length + this.others.length;
  }

  /**
   * Hazards whose box overlaps `rect`, as keys: a point's position in the
   * columns, or the column length plus a line's or area's position.
   */
  private searchKeys(rect: Rect, out: number[]): void {
    const { x, y, nodes, levels, nodeSize: size } = this;
    const stack: number[] = levels.length > 0 ? [levels.length - 1, 0] : [];
    while (stack.length > 0) {
      const k = stack.pop() as number;
      const l = stack.pop() as number;
      if (!overlaps(nodes, (levels[l] as Level).start + k, rect)) {
        continue;
      }
      if (l === 0) {
        for (let r = k * size; r < Math.min(x.length, (k + 1) * size); r++) {
          const px = x[r] as number;
          const py = y[r] as number;
          if (rect.minX <= px && px <= rect.maxX && rect.minY <= py && py <= rect.maxY) {
            out.push(r);
          }
        }
        continue;
      }
      const below = (levels[l - 1] as Level).count;
      for (let c = k * size; c < Math.min(below, (k + 1) * size); c++) {
        stack.push(l - 1, c);
      }
    }
    if (this.otherTree) {
      const from = out.length;
      searchPacked(this.otherTree, rect, out);
      for (let j = from; j < out.length; j++) {
        out[j] = x.length + (out[j] as number);
      }
    }
  }

  /** Feature-list indices of the hazards whose bounding box overlaps `rect`. */
  search(rect: Rect): number[] {
    const keys: number[] = [];
    this.searchKeys(rect, keys);
    return keys.map((k) => this.indexOf(k));
  }

  private indexOf(key: number): number {
    const n = this.x.length;
    return key < n ? (this.feature[key] as number) : (this.others[key - n] as { i: number }).i;
  }

  private depthOf(key: number): number {
    const n = this.x.length;
    if (key >= n) {
      return (this.others[key - n] as { f: DepthFeature }).f.depth;
    }
    const v = this.depths[key] as number;
    return this.code === "f64" ? v : v === LAND_CM[this.code] ? -Infinity : v / 100;
  }

  private featureOf(key: number): DepthFeature {
    const n = this.x.length;
    if (key >= n) {
      return (this.others[key - n] as { f: DepthFeature }).f;
    }
    return {
      ...(this.props[this.prop[key] as number] as Meta["props"][number]),
      geom: { type: "point", p: [this.x[key] as number, this.y[key] as number] },
      depth: this.depthOf(key)
    } as DepthFeature;
  }

  /** The box of hazard `key`, in the scratch rectangle. */
  private boxOf(key: number): Rect {
    const n = this.x.length;
    const b = this.box;
    if (key < n) {
      b.minX = b.maxX = this.x[key] as number;
      b.minY = b.maxY = this.y[key] as number;
      return b;
    }
    const e = 4 * (key - n);
    const o = this.otherBoxes;
    b.minX = o[e] as number;
    b.minY = o[e + 1] as number;
    b.maxX = o[e + 2] as number;
    b.maxY = o[e + 3] as number;
    return b;
  }

  /** Every hazard in the order of the feature list it was built from, each point a new object. */
  features(): DepthFeature[] {
    const out = new Array<DepthFeature>(this.size);
    for (let key = 0; key < this.size; key++) {
      out[this.indexOf(key)] = this.featureOf(key);
    }
    return out;
  }

  /**
   * Hazards within `buffer` Mercator metres of `geom`, shallowest first,
   * across the antimeridian too.
   * Distance is measured to the hazard's bounding box: exact for points, a
   * lower bound for lines, so a nearby hazard is never dropped.
   */
  near(geom: Geom, buffer: number): HazardHit[] {
    const best = new Map<number, number>();
    const reach = expandRect(geomBounds(geom), buffer);
    const keys: number[] = [];
    for (const shift of worldShifts(reach)) {
      const g = shift === 0 ? geom : shiftGeom(geom, shift);
      keys.length = 0;
      this.searchKeys(shiftRect(reach, shift), keys);
      for (const key of keys) {
        const distance = geomRectDistance(g, this.boxOf(key), buffer);
        if (distance <= buffer && distance < (best.get(key) ?? Infinity)) {
          best.set(key, distance);
        }
      }
    }
    // Ties keep the feature order, so the result does not depend on the tree's layout.
    return [...best]
      .map(([key, distance]) => ({ key, distance, depth: this.depthOf(key), i: this.indexOf(key) }))
      .sort((a, b) => a.depth - b.depth || a.distance - b.distance || a.i - b.i)
      .map(({ key, distance }) => ({ feature: this.featureOf(key), distance }));
  }
}
