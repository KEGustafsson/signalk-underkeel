import type { Rect } from "../../src/foundation/geo";
import { expandRect, shiftRect, worldShifts } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import { geomBounds, geomRectDistance, shiftGeom } from "../../src/foundation/geometry";
import type { DepthFeature } from "../../src/ingest/features";

/**
 * The hazard index as it was before `hazards.bin`: the feature objects in an
 * STR-packed tree. Kept so tests can prove the column index finds the same
 * hazards in the same order.
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
  /** Per entry: the hazard's feature index, or a node's first child entry. */
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

interface HazardHit {
  feature: DepthFeature;
  /** Mercator distance from the query geometry (0 when touching). */
  distance: number;
}

/** Hazards in an STR-packed tree with `nodeSize` entries per node. */
export class PackedHazardIndex {
  readonly features: readonly DepthFeature[];
  private readonly tree: Packed | undefined;
  /** Scratch for a hazard's box, handed to the distance test. */
  private readonly box: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** Per feature: its box's position in `tree.boxes`. */
  private readonly entryOf: Uint32Array;

  constructor(features: readonly DepthFeature[], nodeSize = 16) {
    this.features = features;
    const n = features.length;
    const rects = new Float64Array(4 * n);
    features.forEach((f, i) => {
      const r = geomBounds(f.geom);
      rects.set([r.minX, r.minY, r.maxX, r.maxY], 4 * i);
    });
    this.tree = n === 0 ? undefined : pack(rects, n, nodeSize);
    this.entryOf = new Uint32Array(n);
    for (let j = 0; j < n; j++) {
      this.entryOf[this.tree?.first[j] as number] = j;
    }
  }

  get size(): number {
    return this.features.length;
  }

  /** Indices of features whose bounding box overlaps `rect`. */
  search(rect: Rect): number[] {
    const out: number[] = [];
    const t = this.tree;
    const stack = t ? [t.root] : [];
    while (t && stack.length > 0) {
      const e = stack.pop() as number;
      const b = t.boxes;
      if (!(
        (b[4 * e] as number) <= rect.maxX &&
        rect.minX <= (b[4 * e + 2] as number) &&
        (b[4 * e + 1] as number) <= rect.maxY &&
        rect.minY <= (b[4 * e + 3] as number)
      )) {
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
    return out;
  }

  /** The box of feature i, in the scratch rectangle. */
  private boxOf(i: number): Rect {
    const b = (this.tree as Packed).boxes;
    const e = 4 * (this.entryOf[i] as number);
    Object.assign(this.box, {
      minX: b[e] as number,
      minY: b[e + 1] as number,
      maxX: b[e + 2] as number,
      maxY: b[e + 3] as number
    });
    return this.box;
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
    for (const shift of worldShifts(reach)) {
      const g = shift === 0 ? geom : shiftGeom(geom, shift);
      for (const i of this.search(shiftRect(reach, shift))) {
        const distance = geomRectDistance(g, this.boxOf(i), buffer);
        if (distance <= buffer && distance < (best.get(i) ?? Infinity)) {
          best.set(i, distance);
        }
      }
    }
    const depth = (i: number): number => (this.features[i] as DepthFeature).depth;
    // Ties keep the feature order, so the result does not depend on the tree's layout.
    return [...best]
      .sort(([i, a], [j, b]) => depth(i) - depth(j) || a - b || i - j)
      .map(([i, distance]) => ({ feature: this.features[i] as DepthFeature, distance }));
  }
}
