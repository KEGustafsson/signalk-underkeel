/**
 * Spherical Web Mercator (EPSG:3857) and tile maths.
 *
 * The index works in projected Mercator metres so that tiles are axis-aligned
 * rectangles. Mercator stretches distances by 1/cos(lat); `groundToMercator`
 * converts a ground distance into Mercator metres at a latitude, and callers
 * pass the highest |lat| of the area they test so the result is never smaller
 * than the true buffer on the WGS84 ellipsoid.
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

/** WGS84 degrees to Web Mercator metres; latitude is clamped to ±85.05°. */
export function toMercator(lon: number, lat: number): XY {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const x = MERCATOR_RADIUS * lon * DEG;
  const y = MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
  return [x, y];
}

/** Web Mercator metres back to WGS84 degrees. */
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

/** WGS84 first eccentricity squared. */
const WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);

/**
 * The ellipsoid's meridian radius falls to a(1 − e²) at the equator, so a
 * ground metre north spans up to this many spherical Mercator metres per
 * 1/cos(lat). East–west the prime vertical radius is never below a.
 */
const ELLIPSOID_STRETCH = 1 / (1 - WGS84_E2);

/**
 * Mercator metres that span at least `metres` on the ground at latitude
 * `latDeg`, in every direction. Mercator scale grows with latitude, so
 * using the highest latitude of a region gives the largest (most
 * conservative) buffer for that region.
 */
export function groundToMercator(metres: number, latDeg: number): number {
  return (
    (metres * ELLIPSOID_STRETCH) / Math.cos(Math.min(Math.abs(latDeg), MAX_MERCATOR_LAT) * DEG)
  );
}

const TILE_SIZES = Array.from({ length: 31 }, (_, z) => (2 * MERCATOR_HALF_WORLD) / 2 ** z);

/** Side of a zoom-z tile in Mercator metres (ground size is this times cos(lat)). */
export function tileSize(z: number): number {
  return TILE_SIZES[z] ?? (2 * MERCATOR_HALF_WORLD) / 2 ** z;
}

/** Mercator bounds of tile (z, x, y); y counts down from the north edge, as in XYZ tiles. */
export function tileRect(z: number, x: number, y: number): Rect {
  return tileRectInto(z, x, y, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
}

/** `tileRect` written into `out`, for walks that visit many tiles. */
export function tileRectInto(z: number, x: number, y: number, out: Rect): Rect {
  const size = tileSize(z);
  out.minX = -MERCATOR_HALF_WORLD + x * size;
  out.maxY = MERCATOR_HALF_WORLD - y * size;
  out.minY = out.maxY - size;
  out.maxX = out.minX + size;
  return out;
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

const TILE_COUNTS = Array.from({ length: 31 }, (_, z) => 2 ** z);

/** Collision-free numeric key for a tile at a fixed zoom (z ≤ 26). */
export function tileKey(z: number, x: number, y: number): number {
  return x * (TILE_COUNTS[z] ?? 2 ** z) + y;
}

/** A rectangle that `extendRect` grows from nothing (inverted infinite bounds). */
export function emptyRect(): Rect {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

/** Grows `rect` in place to include (x, y). */
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

/**
 * Eastward shifts, in Mercator metres, that bring the parts of `reach`
 * past ±180° back onto the world: 0 first, then one per side crossed.
 * Footprints and buffers stay continuous across the antimeridian, so a
 * query walks once per shift to see the tiles at the other end.
 */
export function worldShifts(reach: Rect): number[] {
  const shifts = [0];
  if (reach.maxX >= MERCATOR_HALF_WORLD) {
    shifts.push(-2 * MERCATOR_HALF_WORLD);
  }
  if (reach.minX <= -MERCATOR_HALF_WORLD) {
    shifts.push(2 * MERCATOR_HALF_WORLD);
  }
  return shifts;
}

/** A copy of `rect` moved `dx` east. */
export function shiftRect(rect: Rect, dx: number): Rect {
  return { minX: rect.minX + dx, minY: rect.minY, maxX: rect.maxX + dx, maxY: rect.maxY };
}

/** A copy of `rect` widened by `by` on every side. */
export function expandRect(rect: Rect, by: number): Rect {
  return {
    minX: rect.minX - by,
    minY: rect.minY - by,
    maxX: rect.maxX + by,
    maxY: rect.maxY + by
  };
}

/** Euclidean distance between two rectangles; 0 when they overlap or touch. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Closed-interval overlap: touching edges count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** `inner` lies within `outer`, edges included. */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS = 6371008.8;

/** Ground distance in metres between two WGS84 points (haversine). */
export function haversine(a: LonLat, b: LonLat): number {
  const R = EARTH_RADIUS;
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * A point `east`/`north` metres from `origin` in the local tangent plane of
 * the WGS84 ellipsoid, using its meridian and prime vertical radii at the
 * origin. Accurate to a few centimetres over the few kilometres a
 * look-ahead or a route leg spans; the mean-radius sphere fell short by up
 * to 0.7 % north–south. The longitude is not wrapped: a ring built around
 * one origin stays continuous across ±180°, and queries walk the far side too.
 */
export function offset(origin: LonLat, east: number, north: number): LonLat {
  const phi = origin[1] * DEG;
  const w = 1 - WGS84_E2 * Math.sin(phi) ** 2;
  const meridian = (MERCATOR_RADIUS * (1 - WGS84_E2)) / w ** 1.5;
  const primeVertical = MERCATOR_RADIUS / Math.sqrt(w);
  const lat = origin[1] + north / meridian / DEG;
  const lon = origin[0] + east / (primeVertical * Math.cos(phi)) / DEG;
  return [lon, lat];
}

/** Metres per radian north and east at a point: the radii `offset` uses there. */
export interface LocalScale {
  meridian: number;
  /** Prime vertical radius times cos(latitude). */
  parallel: number;
}

export function localScale(origin: LonLat): LocalScale {
  const phi = origin[1] * DEG;
  const w = 1 - WGS84_E2 * Math.sin(phi) ** 2;
  return {
    meridian: (MERCATOR_RADIUS * (1 - WGS84_E2)) / w ** 1.5,
    parallel: (MERCATOR_RADIUS / Math.sqrt(w)) * Math.cos(phi)
  };
}

/** `offset` with the origin's scale computed once, for several points around it; the same result. */
export function offsetBy(origin: LonLat, k: LocalScale, east: number, north: number): LonLat {
  return [origin[0] + east / k.parallel / DEG, origin[1] + north / k.meridian / DEG];
}

/** Longitude in [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** The point `distance` metres from `origin` along true bearing `bearing` (radians). */
export function project(origin: LonLat, bearing: number, distance: number): LonLat {
  return offset(origin, distance * Math.sin(bearing), distance * Math.cos(bearing));
}
