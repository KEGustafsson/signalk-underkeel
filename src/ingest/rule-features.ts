import { splitLine, splitRing } from "../foundation/antimeridian";
import type { LonLat, XY } from "../foundation/geo";
import { fromMercator, toMercator, wrapLon } from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import type { GeoJsonFeatureCollection } from "./s57-geojson";
import { toParts } from "./s57-geojson";

/**
 * S-57 objects a leg is held to besides depth (plan §4.11): what passes overhead, with its
 * vertical clearance, and the areas with a hard rule. Kept apart from the depth features, in
 * Web Mercator metres like them, and saved with the index (`spatial/rules.ts`).
 */

/** Overhead objects with a vertical clearance. */
export const OVERHEAD_CLASSES = ["BRIDGE", "CBLOHD", "PIPOHD"] as const;

/** The object layers read for rules. */
export const RULE_LAYERS = [...OVERHEAD_CLASSES, "RESARE", "TSSLPT"] as const;

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

/** The points in lon/lat, each within 180° of the one before: continuous across ±180°. */
function unwrapped(points: readonly XY[]): LonLat[] {
  const out: LonLat[] = [];
  for (const [x, y] of points) {
    const [lon, lat] = fromMercator(x, y);
    const before = out[out.length - 1];
    out.push([before ? before[0] + wrapLon(lon - before[0]) : lon, lat]);
  }
  return out;
}

const spansWorlds = (points: readonly LonLat[]): boolean =>
  points.some((p) => p[0] < -180 || p[0] > 180);

const mercator = (points: readonly LonLat[]): XY[] => points.map((p) => toMercator(p[0], p[1]));

/**
 * `geom` cut where it crosses ±180°, each part within [-180°, 180°], so its bounds stay local:
 * stored whole, a bridge across the meridian would span the world. A polygon cut there keeps
 * its outer ring alone: the area only grows, so no rule is lost. Anything else is unchanged.
 */
export function cutAtAntimeridian(geom: Geom): Geom[] {
  if (geom.type === "point") {
    return [geom];
  }
  if (geom.type === "line") {
    const line = unwrapped(geom.coords);
    return spansWorlds(line)
      ? splitLine(line).map((part) => ({ type: "line", coords: mercator(part) }))
      : [geom];
  }
  const outers = geom.polygons.map((p) => unwrapped(p.outer));
  if (!outers.some(spansWorlds)) {
    return [geom];
  }
  const whole = geom.polygons.filter((_, i) => !spansWorlds(outers[i] as LonLat[]));
  const cut = outers.filter(spansWorlds).flatMap((outer) =>
    splitRing(outer).map((ring): Geom => ({
      type: "polygon",
      polygons: [{ outer: mercator(ring), holes: [] }]
    }))
  );
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
    const clearance = clearanceOf(cls, props);
    const restrictions = cls === "RESARE" ? codes(props.RESTRN) : undefined;
    const orient = cls === "TSSLPT" ? number(props.ORIENT) : undefined;
    const lnam = typeof props.LNAM === "string" && props.LNAM !== "" ? props.LNAM : undefined;
    const verdat = clearance === undefined ? undefined : number(props.VERDAT);
    for (const geom of parts.flatMap((part) => cutAtAntimeridian(part.geom))) {
      out.push({
        objectClass: cls,
        geom,
        cellRef,
        ...(clearance !== undefined && { clearance }),
        ...(restrictions && { restrictions }),
        ...(orient !== undefined && { orient: ((orient % 360) + 360) % 360 }),
        ...(verdat !== undefined && { verdat }),
        ...(lnam && { lnam })
      });
    }
  });
  return out;
}
