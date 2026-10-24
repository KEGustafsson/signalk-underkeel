import type { Geom, PolygonGeom } from "../foundation/geometry";
import type { XY } from "../foundation/geo";
import { toMercator } from "../foundation/geo";
import type { Catzoc, ChartFeature, DepthFeature, PositionFeature, ScaleFeature } from "./features";

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
  advisory?: boolean;
  /** 1σ position of the cell's land and shoreline objects, metres (`DepthFeature.topoSigma`). */
  topoSigma?: number;
  /** The cell's compilation scale denominator (`FeatureBase.scale`). */
  scale?: number;
}

/**
 * Land and shoreline objects. Their charted position comes from the
 * shoreline compilation, not from the hydrographic survey CATZOC rates, so
 * they are placed by their own accuracy where the export states it.
 */
export const TOPOGRAPHY: ReadonlySet<string> = new Set([
  "LNDARE",
  "COALNE",
  "SLCONS",
  "PONTON",
  "FLODOC",
  "HULKES"
]);

/**
 * Not an S-57 object class: the spatial records of a cell whose position is
 * not surveyed, built by the gdal3.js reader from GDAL's primitive layers.
 * Its presence, even empty, says the cell's positional quality is known.
 */
export const POSITION_LAYER = "QUAPOS";

/**
 * M_CSCL: the parts of a cell compiled from a smaller scale (CSCALE) than
 * its DSPM_CSCL, kept as areas of their own (`ScaleFeature`): the build
 * widens the drawing σ only where one reaches a leaf.
 */
export const SCALE_LAYER = "M_CSCL";

/** QUAPOS 1 (surveyed), 10 (precisely known) and 11 (calculated); absent means surveyed. */
const SURVEYED_QUAPOS: ReadonlySet<number> = new Set([1, 10, 11]);

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
  "PONTON",
  "FLODOC",
  "HULKES",
  "UNSARE",
  "M_QUAL",
  "M_COVR",
  SCALE_LAYER,
  POSITION_LAYER
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

/** A line string needs two positions; a linear ring four, the last repeating the first. */
function line(coords: unknown, min = 2): XY[] {
  const positions = list(coords);
  if (positions.length < min) {
    throw new Error(`GeoJSON ${min === 2 ? "line" : "ring"} has ${positions.length} positions`);
  }
  return positions.map(xy);
}

const ring = (coords: unknown): XY[] => line(coords, 4);

function polygonFrom(coords: unknown): PolygonGeom {
  const rings = list(coords);
  if (rings.length === 0) {
    throw new Error("GeoJSON polygon has no rings");
  }
  return { outer: ring(rings[0]), holes: rings.slice(1).map(ring) };
}

function nonEmpty<T>(items: T[], what: string): T[] {
  if (items.length === 0) {
    throw new Error(`GeoJSON ${what} is empty`);
  }
  return items;
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
      return nonEmpty(list(c), "MultiPoint").map(point);
    case "LineString":
      return [{ geom: { type: "line", coords: line(c) } }];
    case "MultiLineString":
      return nonEmpty(list(c), "MultiLineString").map((l) => ({
        geom: { type: "line", coords: line(l) }
      }));
    case "Polygon":
      return [{ geom: { type: "polygon", polygons: [polygonFrom(c)] } }];
    case "MultiPolygon":
      return [
        {
          geom: { type: "polygon", polygons: nonEmpty(list(c), "MultiPolygon").map(polygonFrom) }
        }
      ];
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
 * WATLEV 1 (partly submerged at high water), 2 (always dry), 4 (covers and
 * uncovers) and 6 (subject to inundation) all dry at some water level.
 */
const DRYING_WATLEV = new Set([1, 2, 4, 6]);

/**
 * Depth of a point hazard. VALSOU wins. Without it, a hazard that dries
 * counts as land; every other case has an unknown depth, which is taken as
 * 0 m (at chart datum) rather than the surrounding area's depth.
 */
export function hazardDepth(props: Record<string, unknown>): number {
  const valsou = num(props, "VALSOU");
  if (valsou !== undefined) {
    return valsou;
  }
  const watlev = num(props, "WATLEV");
  return watlev !== undefined && DRYING_WATLEV.has(watlev) ? -Infinity : 0;
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
    case "PONTON":
    case "FLODOC":
    case "HULKES":
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

/** A spatial record of QUAPOS.geojson, when it is not surveyed or states its accuracy. */
function positionFeature(
  props: Record<string, unknown>,
  base: Omit<PositionFeature, "role" | "lowAccuracy" | "posacc">
): PositionFeature | undefined {
  const quapos = num(props, "QUAPOS");
  const posacc = num(props, "POSACC");
  const lowAccuracy = quapos !== undefined && !SURVEYED_QUAPOS.has(quapos);
  return lowAccuracy || posacc !== undefined
    ? { ...base, role: "position", lowAccuracy, posacc }
    : undefined;
}

function featureFor(
  layer: S57Layer,
  props: Record<string, unknown>,
  part: Part,
  ctx: LayerContext
): ChartFeature | undefined {
  const base = { objectClass: layer, geom: part.geom, ...whereOf(ctx), lnam: str(props, "LNAM") };
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
    case "UNSARE":
      return isArea ? { ...base, role: "unsurveyed" } : undefined;
    case SCALE_LAYER:
      return scaleArea(num(props, "CSCALE"), base, ctx);
    case "DEPARE":
    case "DRGARE":
      if (!isArea) {
        return undefined;
      }
      break;
    default:
      break;
  }
  return placed(ctx.topoSigma, {
    ...base,
    role: "depth",
    depth: depthOf(layer, props, part),
    hazard: !isArea,
    dredged: layer === "DRGARE"
  });
}

/** The context every feature of a layer carries: only land objects take the topographic σ (`placed`). */
function whereOf(ctx: LayerContext): Omit<LayerContext, "topoSigma"> {
  const where: LayerContext = { ...ctx };
  delete where.topoSigma;
  return where;
}

/**
 * An M_CSCL area that widens the drawing σ: a polygon at a smaller scale
 * than the cell's, in a cell whose drawing has a σ of its own (`placed`). An
 * area at a larger scale would only narrow it, so it is left out.
 */
function scaleArea(
  cscale: number | undefined,
  base: Omit<ScaleFeature, "role" | "scale">,
  ctx: LayerContext
): ScaleFeature | undefined {
  const widens =
    base.geom.type === "polygon" &&
    ctx.topoSigma !== undefined &&
    ctx.scale !== undefined &&
    cscale !== undefined &&
    cscale > ctx.scale;
  return widens ? { ...base, role: "scale", scale: cscale } : undefined;
}

/**
 * Depth areas: their contours are compiled at the cell's scale and fitted to
 * its shoreline, so they are placed by its drawing like land (plan §4.3).
 * CATZOC's position accuracy rates where the survey put its soundings and
 * dangers; its depth accuracy stays in σD.
 */
const DRAWN_AREAS: ReadonlySet<string> = new Set(["DEPARE", "DRGARE"]);

/**
 * A land or shoreline object, or a depth area, with the cell's own position
 * σ, when the export states the cell's positional quality.
 */
function placed(topoSigma: number | undefined, f: DepthFeature): DepthFeature {
  const drawn = TOPOGRAPHY.has(f.objectClass) || DRAWN_AREAS.has(f.objectClass);
  return topoSigma !== undefined && drawn ? { ...f, topoSigma } : f;
}

/**
 * GDAL's primitive Edge layer holds an edge's interior vertices only; its
 * ends are the connected nodes NODE0 and NODE1, exported beside it as
 * `cnode` records. The whole edge is rebuilt from them, as a line, or as a
 * point when only one position is known.
 */
function edgeGeometry(
  f: GeoJsonFeature,
  nodes: ReadonlyMap<number, unknown>
): GeoJsonGeometry | null {
  const props = f.properties ?? {};
  const interior = f.geometry?.type === "LineString" ? list(f.geometry.coordinates ?? []) : [];
  const ends = [num(props, "NODE0"), num(props, "NODE1")].map((r) =>
    r === undefined ? undefined : nodes.get(r)
  );
  const coords = [ends[0], ...interior, ends[1]].filter((c) => c !== undefined);
  if (coords.length === 0) {
    return null;
  }
  return coords.length === 1
    ? { type: "Point", coordinates: coords[0] }
    : { type: "LineString", coordinates: coords };
}

/**
 * The records of `QUAPOS.geojson` whose position is not surveyed or that
 * state their accuracy: edges rebuilt whole, connected and isolated nodes.
 */
function parsePositions(collection: GeoJsonFeatureCollection, ctx: LayerContext): ChartFeature[] {
  const nodes = new Map<number, unknown>();
  for (const f of collection.features) {
    const rcid = num(f.properties ?? {}, "RCID");
    if (f.properties?.PRIM === "cnode" && rcid !== undefined && f.geometry?.type === "Point") {
      nodes.set(rcid, f.geometry.coordinates);
    }
  }
  const where = whereOf(ctx);
  const out: ChartFeature[] = [];
  collection.features.forEach((f, i) => {
    const props = f.properties ?? {};
    const geometry = props.PRIM === "edge" ? edgeGeometry(f, nodes) : f.geometry;
    let parts: Part[];
    try {
      parts = toParts(geometry);
    } catch (err) {
      throw new Error(`${POSITION_LAYER} feature ${i}: ${(err as Error).message}`, { cause: err });
    }
    for (const part of parts) {
      const p = positionFeature(props, { objectClass: POSITION_LAYER, geom: part.geom, ...where });
      if (p) {
        out.push(p);
      }
    }
  });
  return out;
}

/**
 * Normalised features of one S-57 layer. Geometry the role cannot use (a
 * line in DEPARE, say) is skipped; malformed geometry throws with the layer
 * and feature index.
 */
export function parseLayer(
  layer: S57Layer,
  collection: GeoJsonFeatureCollection,
  ctx: LayerContext
): ChartFeature[] {
  if (layer === POSITION_LAYER) {
    return parsePositions(collection, ctx);
  }
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
