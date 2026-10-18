import type { Zone } from "./engine/acks";
import type { LonLat } from "./foundation/geo";

/**
 * Mooring zones (plan §4.8) are Signal K `regions` resources named in the
 * configuration, so they are drawn on the plotter like any region. A region
 * that cannot be read is reported, never silently skipped.
 */

function ringOf(coords: unknown): LonLat[] | undefined {
  if (!Array.isArray(coords) || coords.length < 4) {
    return undefined;
  }
  const ring: LonLat[] = [];
  for (const p of coords as unknown[]) {
    const [lon, lat] = Array.isArray(p) ? (p as unknown[]) : [];
    if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon + lat)) {
      return undefined;
    }
    ring.push([lon, lat]);
  }
  return ring.slice(0, -1);
}

/** The outer rings of a region resource's Polygon or MultiPolygon. */
export function zonesFromRegion(id: string, region: unknown): Zone[] {
  const r = region as {
    name?: unknown;
    feature?: { geometry?: { type?: unknown; coordinates?: unknown } };
  } | null;
  const name = typeof r?.name === "string" && r.name !== "" ? r.name : id;
  const g = r?.feature?.geometry;
  const polygons =
    g?.type === "Polygon"
      ? [g.coordinates]
      : g?.type === "MultiPolygon"
        ? (g.coordinates as unknown[])
        : [];
  const rings = (Array.isArray(polygons) ? polygons : []).map((p) =>
    ringOf(Array.isArray(p) ? (p as unknown[])[0] : undefined)
  );
  if (rings.length === 0 || rings.some((ring) => ring === undefined)) {
    throw new Error(`region ${id} has no valid Polygon or MultiPolygon geometry`);
  }
  return (rings as LonLat[][]).map((polygon) => ({ name, polygon }));
}

export async function loadZones(
  ids: readonly string[],
  getRegion: (id: string) => Promise<unknown>
): Promise<{ zones: Zone[]; errors: string[] }> {
  const zones: Zone[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      zones.push(...zonesFromRegion(id, await getRegion(id)));
    } catch (err) {
      errors.push(`mooring zone ${id}: ${(err as Error).message}`);
    }
  }
  return { zones, errors };
}
