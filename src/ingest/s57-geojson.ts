import type { Geom, PolygonGeom } from "../foundation/geometry";
import type { XY } from "../foundation/geo";
import { toMercator } from "../foundation/geo";
import type { Catzoc, ChartFeature } from "./features";

/**
 * Reads S-57 object classes that GDAL's S-57 driver exported as one GeoJSON
 * FeatureCollection per layer (`ogr2ogr -f GeoJSON DEPARE.geojson cell.000
 * DEPARE`). Soundings are expected with SPLIT_MULTIPOINT=ON and
 * ADD_SOUNDG_DEPTH=ON, but 3-D MultiPoints are accepted too.
 */

export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
}

export interface GeoJsonFeature {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

export interface LayerContext {
  cellRef: number;
  band: number;
}

/** Layers the index uses (plan §4.2). */
export const S57_LAYERS = [
  "DEPARE",
  "DRGARE",
  "SWPARE",
  "SOUNDG",
  "UWTROC",
  "WRECKS",
  "OBSTRN",
  "LNDARE",
  "COALNE",
  "SLCONS",
  "M_QUAL",
  "M_COVR"
] as const;

export type S57Layer = (typeof S57_LAYERS)[number];

type Position = readonly number[];

/**
 * GeoJSON files are external input. A position that is not two finite
 * numbers is refused: a NaN coordinate would match no tile and silently
 * drop a hazard from the index.
 */
function position(pos: unknown): Position {
  const p = pos as unknown[];
  if (
    !Array.isArray(p) ||
    typeof p[0] !== "number" ||
    typeof p[1] !== "number" ||
    !Number.isFinite(p[0]) ||
    !Number.isFinite(p[1])
  ) {
    throw new Error(`invalid GeoJSON position ${JSON.stringify(pos)}`);
  }
  return p as Position;
}

function xy(pos: unknown): XY {
  const p = position(pos);
  return toMercator(p[0] as number, p[1] as number);
}

function list(coords: unknown): unknown[] {
  if (!Array.isArray(coords)) {
    throw new Error("GeoJSON coordinates must be an array");
  }
  return coords;
}

function ring(coords: unknown): XY[] {
  return list(coords).map(xy);
}

function polygonFrom(coords: unknown): PolygonGeom {
  const rings = list(coords);
  if (rings.length === 0) {
    throw new Error("GeoJSON polygon has no rings");
  }
  return { outer: ring(rings[0]), holes: rings.slice(1).map(ring) };
}

interface Part {
  geom: Geom;
  /** Third coordinate of a point, used for soundings. */
  z?: number;
}

/** Splits a GeoJSON geometry into index geometries; multi-points become one part each. */
export function toParts(geometry: GeoJsonGeometry | null): Part[] {
  if (!geometry) {
    return [];
  }
  const c = geometry.coordinates;
  const point = (p: unknown): Part => ({ geom: { type: "point", p: xy(p) }, z: position(p)[2] });
  switch (geometry.type) {
    case "Point":
      return [point(c)];
    case "MultiPoint":
      return list(c).map(point);
    case "LineString":
      return [{ geom: { type: "line", coords: ring(c) } }];
    case "MultiLineString":
      return list(c).map((l) => ({ geom: { type: "line", coords: ring(l) } }));
    case "Polygon":
      return [{ geom: { type: "polygon", polygons: [polygonFrom(c)] } }];
    case "MultiPolygon":
      return [{ geom: { type: "polygon", polygons: list(c).map(polygonFrom) } }];
    default:
      return [];
  }
}

function num(props: Record<string, unknown>, key: string): number | undefined {
  const v = props[key];
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function str(props: Record<string, unknown>, key: string): string | undefined {
  const v = props[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Depth of a point hazard. VALSOU wins. Without it, WATLEV 1 (partly
 * submerged) and 2 (always dry) stand above the water and count as land;
 * every other case has an unknown depth, which is taken as 0 m (at chart
 * datum) rather than the surrounding area's depth.
 */
export function hazardDepth(props: Record<string, unknown>): number {
  const valsou = num(props, "VALSOU");
  if (valsou !== undefined) {
    return valsou;
  }
  const watlev = num(props, "WATLEV");
  return watlev === 1 || watlev === 2 ? -Infinity : 0;
}

function catzocOf(props: Record<string, unknown>): Catzoc {
  const c = num(props, "CATZOC");
  return c !== undefined && Number.isInteger(c) && c >= 1 && c <= 6 ? (c as Catzoc) : 6;
}

function depthOf(layer: S57Layer, props: Record<string, unknown>, part: Part): number {
  switch (layer) {
    case "LNDARE":
    case "COALNE":
    case "SLCONS":
      return -Infinity;
    case "SOUNDG":
      return num(props, "DEPTH") ?? part.z ?? 0;
    case "UWTROC":
    case "WRECKS":
    case "OBSTRN":
      return hazardDepth(props);
    default:
      // DEPARE / DRGARE without DRVAL1 are unsurveyed: assume datum level.
      return num(props, "DRVAL1") ?? 0;
  }
}

function featureFor(
  layer: S57Layer,
  props: Record<string, unknown>,
  part: Part,
  ctx: LayerContext
): ChartFeature | undefined {
  const base = { objectClass: layer, geom: part.geom, ...ctx, lnam: str(props, "LNAM") };
  const isArea = part.geom.type === "polygon";
  switch (layer) {
    case "M_COVR":
      return isArea && num(props, "CATCOV") !== 2 ? { ...base, role: "coverage" } : undefined;
    case "M_QUAL":
      return isArea
        ? {
            ...base,
            role: "quality",
            catzoc: catzocOf(props),
            posacc: num(props, "POSACC"),
            souacc: num(props, "SOUACC")
          }
        : undefined;
    case "SWPARE":
      return isArea ? { ...base, role: "swept", depth: num(props, "DRVAL1") ?? 0 } : undefined;
    case "DEPARE":
    case "DRGARE":
      if (!isArea) {
        return undefined;
      }
      break;
    default:
      break;
  }
  return {
    ...base,
    role: "depth",
    depth: depthOf(layer, props, part),
    hazard: !isArea,
    dredged: layer === "DRGARE"
  };
}

export function parseLayer(
  layer: S57Layer,
  collection: GeoJsonFeatureCollection,
  ctx: LayerContext
): ChartFeature[] {
  const out: ChartFeature[] = [];
  collection.features.forEach((f, i) => {
    const props = f.properties ?? {};
    let parts: Part[];
    try {
      parts = toParts(f.geometry);
    } catch (err) {
      throw new Error(`${layer} feature ${i}: ${(err as Error).message}`, { cause: err });
    }
    for (const part of parts) {
      const feature = featureFor(layer, props, part, ctx);
      if (feature) {
        out.push(feature);
      }
    }
  });
  return out;
}
