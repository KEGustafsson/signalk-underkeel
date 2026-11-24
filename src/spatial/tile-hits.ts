import type { Rect } from "../foundation/geo";
import {
  expandRect,
  groundToMercator,
  MERCATOR_HALF_WORLD,
  maxAbsLat,
  rectsOverlap
} from "../foundation/geo";
import { areasCover } from "../foundation/area-cover";
import { geomContainsRect, geomRectDistance } from "../foundation/geometry";
import type { Item } from "./build-items";
import {
  coverAreas,
  FULL,
  MISS,
  polygonsContainRect,
  polygonsRectDistance,
  polygonsRectRelation
} from "./polygon-index";
import { REACH_SLACK } from "./pyramid";

/** The features reaching a tile of the pyramid build (`pyramid-build.ts`). */

export interface Hit {
  item: Item;
  full: boolean;
}

/** Containment is tested this far, in Mercator metres, inside the world's ±180° edge. */
const WORLD_EDGE_INSET = 1e-3;

/**
 * The tile as containment sees it. Nothing lies past ±180°, so a cell whose
 * edge runs along it holds a tile on that edge; read as is, the shared edge
 * left every leaf there uncovered. A real gap past 180° is still found by
 * queries, which walk the tiles at the other end of the world.
 */
function inWorld(rect: Rect): Rect {
  const edge = MERCATOR_HALF_WORLD - WORLD_EDGE_INSET;
  return {
    minX: Math.max(rect.minX, -edge),
    minY: rect.minY,
    maxX: Math.min(rect.maxX, edge),
    maxY: rect.maxY
  };
}

function rectDistance(item: Item, rect: Rect, limit: number): number {
  return item.shape
    ? polygonsRectDistance(item.shape, rect, limit)
    : geomRectDistance(item.f.geom, rect, limit);
}

function containsRect(item: Item, rect: Rect): boolean {
  return item.shape ? polygonsContainRect(item.shape, rect) : geomContainsRect(item.f.geom, rect);
}

export function classify(items: Item[], rect: Rect): Hit[] {
  const scale = groundToMercator(1, maxAbsLat(rect));
  const world = inWorld(rect);
  // Away from ±180° containment sees the tile itself, so one pass decides both tests.
  const onePass = world.minX === rect.minX && world.maxX === rect.maxX;
  const hits: Hit[] = [];
  for (const item of items) {
    if (item.full) {
      hits.push({ item, full: true });
      continue;
    }
    const r = item.radius * scale;
    if (!rectsOverlap(expandRect(rect, r), item.bbox)) {
      continue;
    }
    if (item.shape && item.radius === 0 && onePass) {
      const rel = polygonsRectRelation(item.shape, rect);
      if (rel !== MISS) {
        hits.push({ item, full: rel === FULL });
      }
      continue;
    }
    // The same slack as the query walk, so a tile at the disc's edge is never lost to rounding.
    if (rectDistance(item, rect, r * REACH_SLACK) > r * REACH_SLACK) {
      continue;
    }
    hits.push({ item, full: item.radius === 0 && containsRect(item, world) });
  }
  return hits;
}

/** `areasCoverRect` over the hits' areas, through their indexed polygons. */
export function hitsCover(hits: Hit[], rect: Rect): boolean {
  return areasCover(coverAreas(hits.flatMap((h) => h.item.shape ?? [])), inWorld(rect));
}

/** A depth area: a polygon of charted depth, not a hazard's. */
export function isArea(h: Hit): boolean {
  const f = h.item.f;
  return f.role === "depth" && !f.hazard && f.geom.type === "polygon";
}
