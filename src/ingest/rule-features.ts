import type { Geom } from "../foundation/geometry";
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
    for (const part of parts) {
      out.push({ objectClass: cls, geom: part.geom, cellRef, ...attributes });
    }
  });
  return out;
}
