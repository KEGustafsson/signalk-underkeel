/**
 * Spherical Web Mercator (EPSG:3857) and tile maths.
 *
 * The index works in projected Mercator metres so that tiles are axis-aligned
 * rectangles. Mercator stretches distances by 1/cos(lat); `groundToMercator`
 * converts a ground distance into Mercator metres at a latitude, and callers
 * pass the highest |lat| of the area they test so the result is never smaller
 * than the true buffer.
 */

export const MERCATOR_RADIUS = 6378137;
export const MERCATOR_HALF_WORLD = Math.PI * MERCATOR_RADIUS;
/** Web Mercator is undefined at the poles; clamp to the usual tile limit. */
export const MAX_MERCATOR_LAT = 85.05112878;

/** [longitude, latitude] in degrees, WGS84. */
export type LonLat = readonly [number, number];
/** [x, y] in Web Mercator metres. */
export type XY = readonly [number, number];

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const DEG = Math.PI / 180;

export function toMercator(lon: number, lat: number): XY {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const x = MERCATOR_RADIUS * lon * DEG;
  const y = MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
  return [x, y];
}

export function fromMercator(x: number, y: number): LonLat {
  const lon = x / MERCATOR_RADIUS / DEG;
  const lat = (2 * Math.atan(Math.exp(y / MERCATOR_RADIUS)) - Math.PI / 2) / DEG;
  return [lon, lat];
}

/** Latitude (degrees) of a Mercator northing. */
export function mercatorYToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / MERCATOR_RADIUS)) - Math.PI / 2) / DEG;
}

/** Highest |latitude| inside a Mercator rectangle. */
export function maxAbsLat(rect: Rect): number {
  return Math.max(Math.abs(mercatorYToLat(rect.minY)), Math.abs(mercatorYToLat(rect.maxY)));
}

/**
 * Mercator metres that span `metres` on the ground at latitude `latDeg`.
 * Mercator scale grows with latitude, so using the highest latitude of a
 * region gives the largest (most conservative) buffer for that region.
 */
export function groundToMercator(metres: number, latDeg: number): number {
  return metres / Math.cos(Math.min(Math.abs(latDeg), MAX_MERCATOR_LAT) * DEG);
}

export function tileSize(z: number): number {
  return (2 * MERCATOR_HALF_WORLD) / 2 ** z;
}

export function tileRect(z: number, x: number, y: number): Rect {
  const size = tileSize(z);
  const minX = -MERCATOR_HALF_WORLD + x * size;
  const maxY = MERCATOR_HALF_WORLD - y * size;
  return { minX, minY: maxY - size, maxX: minX + size, maxY };
}

/** Tile column/row containing a Mercator point (clamped to the world). */
export function tileAt(z: number, px: number, py: number): { x: number; y: number } {
  const n = 2 ** z;
  const size = tileSize(z);
  const x = Math.floor((px + MERCATOR_HALF_WORLD) / size);
  const y = Math.floor((MERCATOR_HALF_WORLD - py) / size);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/** Inclusive tile index range at zoom `z` covering a Mercator rectangle. */
export function tileRange(
  z: number,
  rect: Rect
): { minX: number; minY: number; maxX: number; maxY: number } {
  const a = tileAt(z, rect.minX, rect.maxY);
  const b = tileAt(z, rect.maxX, rect.minY);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

/** Collision-free numeric key for a tile at a fixed zoom (z ≤ 26). */
export function tileKey(z: number, x: number, y: number): number {
  return x * 2 ** z + y;
}

export function emptyRect(): Rect {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extendRect(rect: Rect, x: number, y: number): void {
  if (x < rect.minX) {
    rect.minX = x;
  }
  if (y < rect.minY) {
    rect.minY = y;
  }
  if (x > rect.maxX) {
    rect.maxX = x;
  }
  if (y > rect.maxY) {
    rect.maxY = y;
  }
}

export function expandRect(rect: Rect, by: number): Rect {
  return {
    minX: rect.minX - by,
    minY: rect.minY - by,
    maxX: rect.maxX + by,
    maxY: rect.maxY + by
  };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

/** Ground distance in metres between two WGS84 points (haversine). */
export function haversine(a: LonLat, b: LonLat): number {
  const R = 6371008.8;
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
