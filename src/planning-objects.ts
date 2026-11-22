import { splitLine } from "./foundation/antimeridian";
import type { LonLat } from "./foundation/geo";
import { fromMercator, toMercator, wrapLon } from "./foundation/geo";
import type { OwnTrack } from "./livechart/tracks";
import type { WaterLevel } from "./model/uncertainty";
import { FAIRWAY_GAP } from "./ingest/rule-features";
import type { ChartIndex } from "./spatial/chart-index";

/**
 * An S-57 object the route check holds legs to besides depth (feature "objects"): a bridge,
 * an overhead cable or pipe with its vertical clearance above the cell's vertical datum, a
 * restricted area with its RESTRN codes, or a traffic separation lane with its ORIENT.
 */
export interface ChartObject {
  class: string;
  geometry:
    | { type: "Point"; coordinates: LonLat }
    | { type: "LineString"; coordinates: LonLat[] }
    | { type: "MultiPolygon"; coordinates: LonLat[][][] };
  clearance?: number;
  restrictions?: number[];
  orient?: number;
  /** A line with traffic both ways along it, which a boat keeps to starboard of. */
  twoWay?: boolean;
  /** The draft a fairway's navigation line is laid out for, metres. */
  designDraft?: number;
  /** The S-57 cell it is from. */
  cell?: string;
}

const lonLat = (p: readonly number[]): LonLat => {
  const [lon, lat] = fromMercator(p[0] as number, p[1] as number);
  return [lon, lat];
};

/**
 * The largest box `objects` takes, km²: its lookup walks the rules grid over the whole box, so
 * the cost goes with the area. Past a planner's largest region (a 165 km side) with room.
 */
export const MAX_OBJECTS_KM2 = 40_000;

/** The box sw–ne's area, km², on the sphere. */
function boxKm2(sw: LonLat, ne: LonLat): number {
  const rad = Math.PI / 180;
  const r = 6371.0088;
  const w = Math.abs(ne[0] - sw[0]) * rad;
  return r * r * w * Math.abs(Math.sin(ne[1] * rad) - Math.sin(sw[1] * rad));
}

/**
 * The index's rule features (`spatial/rules.ts`) whose bounds meet sw–ne, in lon/lat. A box
 * over MAX_OBJECTS_KM2, or with a corner past ±180° or ±85°, throws RangeError, as an
 * oversized box or leg does.
 */
export function chartObjects(index: ChartIndex, sw: LonLat, ne: LonLat): ChartObject[] {
  if (![sw, ne].every(([lon, lat]) => Math.abs(lon) <= 180 && Math.abs(lat) <= 85)) {
    throw new RangeError("objects corners must lie within ±180° longitude and ±85° latitude");
  }
  const km2 = boxKm2(sw, ne);
  if (!(km2 <= MAX_OBJECTS_KM2)) {
    throw new RangeError(`objects box over ${MAX_OBJECTS_KM2} km²`);
  }
  const [x0, y0] = toMercator(sw[0], sw[1]);
  const [x1, y1] = toMercator(ne[0], ne[1]);
  const r = {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1)
  };
  // A fairway gap strip is no chart object: only a pilotage check reads it (`engine/gap-strips.ts`).
  return index.rules
    .near(r)
    .filter((f) => f.objectClass !== FAIRWAY_GAP)
    .map((f) => {
      const g = f.geom;
      const geometry: ChartObject["geometry"] =
        g.type === "point"
          ? { type: "Point", coordinates: lonLat(g.p) }
          : g.type === "line"
            ? { type: "LineString", coordinates: g.coords.map(lonLat) }
            : {
                type: "MultiPolygon",
                coordinates: g.polygons.map((p) =>
                  [p.outer, ...p.holes].map((ring) => ring.map(lonLat))
                )
              };
      const cell = index.catalogue.cells[f.cellRef]?.name;
      return {
        class: f.objectClass,
        geometry,
        ...(f.clearance !== undefined && { clearance: f.clearance }),
        ...(f.restrictions && { restrictions: [...f.restrictions] }),
        ...(f.orient !== undefined && { orient: f.orient }),
        ...(f.twoWay && { twoWay: true }),
        ...(f.designDraft !== undefined && { designDraft: f.designDraft }),
        ...(cell !== undefined && { cell })
      };
    });
}

/** Whether the segment a–b meets the box sw–ne (Liang–Barsky clipping). */
function segmentMeets(a: LonLat, b: LonLat, sw: LonLat, ne: LonLat): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (let axis = 0; axis < 2; axis++) {
    const delta = d[axis] as number;
    for (const [p, q] of [
      [-delta, (a[axis] as number) - (sw[axis] as number)],
      [delta, (ne[axis] as number) - (a[axis] as number)]
    ] as const) {
      if (p === 0) {
        if (q < 0) {
          return false;
        }
        continue;
      }
      const r = q / p;
      if (p < 0) {
        t0 = Math.max(t0, r);
      } else {
        t1 = Math.min(t1, r);
      }
      if (t0 > t1) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The boat's own tracks meeting sw–ne as `TRACK` objects, each only where the window's lowest
 * water at every point it keeps (`low`, undefined when not known) is no lower than the highest it
 * was sailed at, so it is listed only at water it has been sailed in.
 */
export function trackObjects(
  tracks: readonly OwnTrack[],
  sw: LonLat,
  ne: LonLat,
  low: (at: readonly LonLat[]) => number | undefined
): ChartObject[] {
  const meets = (c: readonly LonLat[]): boolean =>
    c.some((p, i) => i > 0 && segmentMeets(c[i - 1] as LonLat, p, sw, ne));
  return tracks
    .flatMap((t) => localParts(t.coordinates).map((c) => ({ coordinates: c, level: t.level })))
    .filter((t) => meets(t.coordinates))
    .filter((t) => {
      const h = low(t.coordinates);
      return h !== undefined && h >= t.level;
    })
    .map((t) => ({
      class: "TRACK",
      geometry: { type: "LineString" as const, coordinates: t.coordinates }
    }));
}

/**
 * A track's points as lines within [-180°, 180°]: a passage across the antimeridian is cut
 * there, so no leg of it spans the world and meets a box it never came near.
 */
function localParts(points: readonly LonLat[]): LonLat[][] {
  const line: LonLat[] = [];
  for (const [lon, lat] of points) {
    const before = line[line.length - 1];
    line.push([before ? before[0] + wrapLon(lon - before[0]) : lon, lat]);
  }
  return line.some((p) => p[0] < -180 || p[0] > 180)
    ? splitLine(line)
    : [points.map((p): LonLat => [p[0], p[1]])];
}

/**
 * A session's objects in sw–ne: the index's, and the boat's own tracks wherever the window's
 * lowest water (`level`) is known and no lower than they were sailed at.
 */
export function sessionObjects(
  index: ChartIndex,
  tracks: readonly OwnTrack[],
  sw: LonLat,
  ne: LonLat,
  level: (at: readonly LonLat[]) => WaterLevel
): ChartObject[] {
  return [
    ...chartObjects(index, sw, ne),
    ...trackObjects(tracks, sw, ne, (at) => {
      const low = level(at);
      return low.degraded === undefined ? low.h : undefined;
    })
  ];
}
