import type { LonLat } from "../foundation/geo";
import { fromMercator, haversine, offset, tileRect } from "../foundation/geo";
import type { WaterLevel } from "./uncertainty";
import type { LevelReach } from "./water-level";

/**
 * The water level over an area rather than at the vessel (plan §4.5), for
 * UKC tiles and `POST /query`. A provider with a reach gives one level at
 * every position within it and one fallback beyond it, so two levels
 * describe the whole map:
 * - `inside`, the level within the reach;
 * - `beyond`, the lower of that level and the fallback, with the fallback's
 *   σ and reason, which is what a route leg spanning both would get.
 *
 * An area is inside when every corner of its lon/lat box is within the
 * reach. A spherical cap is convex, and the farthest point of a lon/lat box
 * spanning under 180° of longitude from any point is one of its corners, so
 * that puts the whole box inside. Any other area takes `beyond`: for one
 * straddling the edge that is exactly what the lowest level over its points
 * gives, and for one wholly outside it is never wetter than the fallback.
 */

/** The level over areas now. Without `beyond`, `inside` holds everywhere. */
export interface AreaLevels {
  readonly inside: WaterLevel;
  readonly beyond?: { readonly level: WaterLevel; readonly reach: LevelReach };
}

/**
 * Whether every corner lies within the reach: for a lon/lat box spanning
 * under 180° of longitude, whether the whole box does. `<=` is the exact
 * complement of the provider's `>` beyond the reach.
 */
export function withinReach(reach: LevelReach, corners: readonly LonLat[]): boolean {
  return corners.length > 0 && corners.every((c) => haversine(c, reach.centre) <= reach.metres);
}

/**
 * The level for an area given by its box corners. With undefined corners (a
 * box that cannot be bounded), the area counts as beyond.
 */
export function levelOver(levels: AreaLevels, corners: readonly LonLat[] | undefined): WaterLevel {
  const beyond = levels.beyond;
  return !beyond || (corners && withinReach(beyond.reach, corners)) ? levels.inside : beyond.level;
}

/** The four corners of tile (z, x, y), as lon/lat. */
export function tileCorners(z: number, x: number, y: number): LonLat[] {
  const r = tileRect(z, x, y);
  return [
    fromMercator(r.minX, r.minY),
    fromMercator(r.minX, r.maxY),
    fromMercator(r.maxX, r.minY),
    fromMercator(r.maxX, r.maxY)
  ];
}

/**
 * The corners of the lon/lat box holding a query ring and its buffer, or
 * undefined for an empty ring or a box spanning more than 180° of longitude. Query edges are
 * straight in Mercator, so they stay inside the box of their vertices; the
 * buffer is taken as each vertex moved `bufferMetres` east or west and north
 * or south. Longitudes are not wrapped, as the ring's are not.
 */
export function ringCorners(ring: readonly LonLat[], bufferMetres: number): LonLat[] | undefined {
  let w = Infinity;
  let e = -Infinity;
  let s = Infinity;
  let n = -Infinity;
  for (const v of ring) {
    for (const [dx, dy] of [
      [-bufferMetres, -bufferMetres],
      [bufferMetres, bufferMetres]
    ] as const) {
      const [lon, lat] = offset(v, dx, dy);
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  }
  if (ring.length === 0 || !(e - w <= 180)) {
    return undefined;
  }
  return [
    [w, s],
    [w, n],
    [e, s],
    [e, n]
  ];
}
