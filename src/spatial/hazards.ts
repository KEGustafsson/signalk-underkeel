import type { Rect } from "../foundation/geo";
import { expandRect, rectsOverlap } from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { geomBounds, geomRectDistance } from "../foundation/geometry";
import type { DepthFeature } from "../ingest/features";

/**
 * Static R-tree (sort-tile-recursive packing) over the exact geometry of
 * point and line hazards. The pyramid already burns these in; the tree is
 * used to name the hazard behind a result and to refine near a threshold.
 */

interface Node {
  rect: Rect;
  children: Node[];
  items: number[];
}

function unionRect(rects: Rect[]): Rect {
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    minY: Math.min(...rects.map((r) => r.minY)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    maxY: Math.max(...rects.map((r) => r.maxY))
  };
}

function center(r: Rect): [number, number] {
  return [(r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2];
}

/** Groups entries into runs of at most `size`, tiled by x then y. */
function strGroups<T extends { rect: Rect }>(entries: T[], size: number): T[][] {
  const slices = Math.ceil(Math.sqrt(Math.ceil(entries.length / size)));
  const byX = [...entries].sort((a, b) => center(a.rect)[0] - center(b.rect)[0]);
  const perSlice = slices * size;
  const groups: T[][] = [];
  for (let i = 0; i < byX.length; i += perSlice) {
    const slice = byX.slice(i, i + perSlice).sort((a, b) => center(a.rect)[1] - center(b.rect)[1]);
    for (let j = 0; j < slice.length; j += size) {
      groups.push(slice.slice(j, j + size));
    }
  }
  return groups;
}

export interface HazardHit {
  feature: DepthFeature;
  /** Mercator distance from the query geometry (0 when touching). */
  distance: number;
}

export class HazardIndex {
  readonly features: readonly DepthFeature[];
  private readonly rects: Rect[];
  private readonly root: Node | undefined;

  constructor(features: readonly DepthFeature[], nodeSize = 16) {
    this.features = features;
    this.rects = features.map((f) => geomBounds(f.geom));
    let level: Node[] = this.rects.map((rect, i) => ({ rect, children: [], items: [i] }));
    if (level.length === 0) {
      this.root = undefined;
      return;
    }
    while (level.length > 1) {
      level = strGroups(level, nodeSize).map((group) => ({
        rect: unionRect(group.map((n) => n.rect)),
        children: group,
        items: []
      }));
    }
    this.root = level[0];
  }

  get size(): number {
    return this.features.length;
  }

  /** Indices of features whose bounding box overlaps `rect`. */
  search(rect: Rect): number[] {
    const out: number[] = [];
    const stack = this.root ? [this.root] : [];
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      if (!rectsOverlap(node.rect, rect)) {
        continue;
      }
      out.push(...node.items);
      stack.push(...node.children);
    }
    return out;
  }

  /**
   * Hazards within `buffer` Mercator metres of `geom`, shallowest first.
   * Distance is measured to the hazard's bounding box: exact for points, a
   * lower bound for lines, so a nearby hazard is never dropped.
   */
  near(geom: Geom, buffer: number): HazardHit[] {
    const hits: HazardHit[] = [];
    for (const i of this.search(expandRect(geomBounds(geom), buffer))) {
      const distance = geomRectDistance(geom, this.rects[i] as Rect, buffer);
      if (distance <= buffer) {
        hits.push({ feature: this.features[i] as DepthFeature, distance });
      }
    }
    return hits.sort((a, b) => a.feature.depth - b.feature.depth || a.distance - b.distance);
  }
}
