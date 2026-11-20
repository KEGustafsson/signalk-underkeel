import type { LonLat } from "./foundation/geo";
import { fromMercator, toMercator } from "./foundation/geo";
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
  /** The S-57 cell it is from. */
  cell?: string;
}

const lonLat = (p: readonly number[]): LonLat => {
  const [lon, lat] = fromMercator(p[0] as number, p[1] as number);
  return [lon, lat];
};

/** The index's rule features (`spatial/rules.ts`) whose bounds meet sw–ne, in lon/lat. */
export function chartObjects(index: ChartIndex, sw: LonLat, ne: LonLat): ChartObject[] {
  const [x0, y0] = toMercator(sw[0], sw[1]);
  const [x1, y1] = toMercator(ne[0], ne[1]);
  const r = {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1)
  };
  return index.rules.near(r).map((f) => {
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
      ...(f.restrictions && { restrictions: f.restrictions }),
      ...(f.orient !== undefined && { orient: f.orient }),
      ...(cell !== undefined && { cell })
    };
  });
}
