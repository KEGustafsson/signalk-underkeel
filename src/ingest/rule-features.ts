import { splitLine, splitRing } from "../foundation/antimeridian";
import type { LonLat, XY } from "../foundation/geo";
import { fromMercator, toMercator, wrapLon } from "../foundation/geo";
import type { Geom, PolygonGeom } from "../foundation/geometry";
import type { GeoJsonFeatureCollection } from "./s57-geojson";
import { toParts } from "./s57-geojson";

/**
 * S-57 objects a leg is held to besides depth (plan §4.11): what passes overhead, with its
 * vertical clearance, and the areas with a hard rule; and the lines and areas a planner keeps
 * to or waits at. Kept apart from the depth features, in
 * Web Mercator metres like them, and saved with the index (`spatial/rules.ts`).
 */

/** Overhead objects with a vertical clearance. */
export const OVERHEAD_CLASSES = ["BRIDGE", "CBLOHD", "PIPOHD"] as const;

/**
 * Objects a planner keeps to or waits at, which no verdict reads: leading lines, recommended
 * tracks, anchorage areas, and the fairway navigation lines of a WFS cell (`NAVLINE`).
 */
export const PREFERENCE_CLASSES = ["NAVLNE", "RECTRC", "ACHARE", "NAVLINE"] as const;

/** The object layers read for rules and preferences. */
export const RULE_LAYERS = [
  ...OVERHEAD_CLASSES,
  "RESARE",
  "TSSLPT",
  ...PREFERENCE_CLASSES
] as const;

export type RuleClass = (typeof RULE_LAYERS)[number];

export interface RuleFeature {
  objectClass: RuleClass;
  geom: Geom;
  /** Index into the cell catalogue: the cell's vertical datum relates the clearance to the water. */
  cellRef: number;
  /**
   * Vertical clearance above its datum (`verdat`, else the cell's vertical datum), metres: a
   * bridge's closed clearance (VERCCL) when it opens, else VERCLR; a cable's or pipe's safe
   * clearance (VERCSA), else VERCLR. Absent when the object states none.
   */
  clearance?: number;
  /** RESARE's RESTRN codes: 7 entry prohibited, 8 entry restricted, 14 area to be avoided. */
  restrictions?: number[];
  /** TSSLPT's ORIENT: the lane's direction of traffic, degrees true. */
  orient?: number;
  /** The object's own VERDAT, the datum of its clearance, in place of its cell's. */
  verdat?: number;
  /** A line with traffic both ways along it: RECTRC with TRAFIC 4, a WFS navigation line. */
  twoWay?: boolean;
  /** The draft a fairway's navigation line is laid out for, metres. */
  designDraft?: number;
  lnam?: string;
}

function number(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** A list attribute as GDAL writes it: an array, or the codes in a comma-separated string. */
function codes(v: unknown): number[] | undefined {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [v];
  const out = items.map(number).filter((n): n is number => n !== undefined);
  return out.length > 0 ? out : undefined;
}

function clearanceOf(cls: RuleClass, props: Record<string, unknown>): number | undefined {
  if (!(OVERHEAD_CLASSES as readonly string[]).includes(cls)) {
    return undefined;
  }
  // An opening bridge is passed closed unless the boat waits for it to open; a cable at its safe
  // clearance, which keeps clear of electrical discharge.
  if (cls === "BRIDGE") {
    return number(props.VERCCL) ?? number(props.VERCLR);
  }
  return number(props.VERCSA) ?? number(props.VERCLR);
}

/** A feature's attributes as a rule feature keeps them, each only when the object states it. */
function attributesOf(
  cls: RuleClass,
  props: Record<string, unknown>
): Omit<RuleFeature, "objectClass" | "geom" | "cellRef"> {
  const clearance = clearanceOf(cls, props);
  const restrictions = cls === "RESARE" ? codes(props.RESTRN) : undefined;
  const lnam = typeof props.LNAM === "string" && props.LNAM !== "" ? props.LNAM : undefined;
  const verdat = clearance === undefined ? undefined : number(props.VERDAT);
  return {
    ...(clearance !== undefined && { clearance }),
    ...(restrictions && { restrictions }),
    ...(verdat !== undefined && { verdat }),
    ...lineAttributes(cls, props),
    ...(lnam && { lnam })
  };
}

/** A line's direction, whether traffic runs both ways along it, and its design draft. */
function lineAttributes(
  cls: RuleClass,
  props: Record<string, unknown>
): Pick<RuleFeature, "orient" | "twoWay" | "designDraft"> {
  const orient = cls === "TSSLPT" || cls === "NAVLNE" ? number(props.ORIENT) : undefined;
  const twoWay = (cls === "RECTRC" && number(props.TRAFIC) === 4) || cls === "NAVLINE";
  const designDraft = cls === "NAVLINE" ? number(props.mitoitussyvays) : undefined;
  return {
    ...(orient !== undefined && { orient: ((orient % 360) + 360) % 360 }),
    ...(twoWay && { twoWay: true }),
    ...(designDraft !== undefined && { designDraft })
  };
}

/** The width of the world in Web Mercator metres: 360° of longitude. */
const WORLD = 2 * toMercator(180, 0)[0];

/**
 * Per point, the whole turns that make the line continuous across ±180°: each point within
 * 180° of the one before, the first within 180° of `ref` when given.
 */
function turnsOf(points: readonly XY[], ref?: number): number[] {
  const turns: number[] = [];
  let before = ref;
  for (const [x, y] of points) {
    const lon = fromMercator(x, y)[0];
    const at = before === undefined ? lon : before + wrapLon(lon - before);
    turns.push(Math.round((at - lon) / 360));
    before = at;
  }
  return turns;
}

const lonLatOf = (points: readonly XY[], turns: readonly number[]): LonLat[] =>
  points.map(([x, y], i) => {
    const [lon, lat] = fromMercator(x, y);
    return [lon + 360 * (turns[i] ?? 0), lat];
  });

const spansWorlds = (points: readonly LonLat[]): boolean =>
  points.some((p) => p[0] < -180 || p[0] > 180);

const mercator = (points: readonly LonLat[]): XY[] => points.map((p) => toMercator(p[0], p[1]));

/** `points` moved by their turns: exactly as they were when none is needed. */
function shifted(points: readonly XY[], turns: readonly number[]): readonly XY[] {
  return turns.every((k) => k === 0)
    ? points
    : points.map(([x, y], i): XY => [x + WORLD * (turns[i] ?? 0), y]);
}

/**
 * `geom` cut where it crosses ±180°, each part within [-180°, 180°], so its bounds stay local:
 * stored whole, a bridge across the meridian would span the world. A shape that only touches
 * the meridian, with a vertex at +180° where its others lie east of -180°, has that vertex
 * moved to its side. A polygon cut there keeps its outer ring alone: the area only grows, so
 * no rule is lost. Anything else is unchanged.
 */
export function cutAtAntimeridian(geom: Geom): Geom[] {
  if (geom.type === "point") {
    return [geom];
  }
  if (geom.type === "line") {
    const turns = turnsOf(geom.coords);
    const line = lonLatOf(geom.coords, turns);
    return spansWorlds(line)
      ? splitLine(line).map((part) => ({ type: "line", coords: mercator(part) }))
      : [
          turns.every((k) => k === 0) ? geom : { type: "line", coords: shifted(geom.coords, turns) }
        ];
  }
  const whole: PolygonGeom[] = [];
  const cut: Geom[] = [];
  for (const p of geom.polygons) {
    const turns = turnsOf(p.outer);
    const outer = lonLatOf(p.outer, turns);
    if (spansWorlds(outer)) {
      for (const ring of splitRing(outer)) {
        cut.push({ type: "polygon", polygons: [{ outer: mercator(ring), holes: [] }] });
      }
      continue;
    }
    const ref = outer[0]?.[0];
    whole.push({
      outer: shifted(p.outer, turns),
      holes: p.holes.map((h) => shifted(h, turnsOf(h, ref)))
    });
  }
  return whole.length > 0 ? [{ type: "polygon", polygons: whole }, ...cut] : cut;
}

/** The rule features of one layer of a cell. Malformed geometry throws with the feature index. */
export function parseRuleLayer(
  cls: RuleClass,
  collection: GeoJsonFeatureCollection,
  cellRef: number
): RuleFeature[] {
  const out: RuleFeature[] = [];
  collection.features.forEach((f, i) => {
    const props = f.properties ?? {};
    let parts;
    try {
      parts = toParts(f.geometry);
    } catch (err) {
      throw new Error(`${cls} feature ${i}: ${(err as Error).message}`, { cause: err });
    }
    const attributes = attributesOf(cls, props);
    for (const geom of parts.flatMap((part) => cutAtAntimeridian(part.geom))) {
      out.push({ objectClass: cls, geom, cellRef, ...attributes });
    }
  });
  return out;
}
