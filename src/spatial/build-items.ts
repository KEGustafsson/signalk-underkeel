import type { Rect } from "../foundation/geo";
import { emptyRect, extendRect, rectsOverlap } from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { geomBounds, geomRectDistance } from "../foundation/geometry";
import type { ChartFeature, QualityFeature } from "../ingest/features";
import type { PolygonIndex } from "./polygon-index";
import { indexPolygon } from "./polygon-index";
import type { QualityOptions } from "./quality";
import { DEFAULT_QUALITY, sigmaFor } from "./quality";

/** What the pyramid build reads of each feature: its box, burn radius and indexed polygons. */

export interface BuildOptions {
  minZoom: number;
  leafZoom: number;
  /** Point hazards and soundings are burned within k·σP of their position. */
  k: number;
  quality: QualityOptions;
}

export const DEFAULT_BUILD: BuildOptions = {
  minZoom: 10,
  leafZoom: 20,
  k: 2,
  quality: DEFAULT_QUALITY
};

export interface Item {
  f: ChartFeature;
  bbox: Rect;
  /** Burn radius in ground metres (0 for areas). */
  radius: number;
  /** The feature's polygons, indexed for the tile tests. */
  shape: PolygonIndex[] | undefined;
  /** The feature contains an ancestor tile, and so every tile below it. */
  full?: boolean;
}

interface Zone {
  q: QualityFeature;
  bbox: Rect;
}

/**
 * Burn radius of a point hazard or sounding: k·σP of the quality zones of
 * its own cell that contain it. Lines and areas are not widened; the query
 * buffer (plan §4.7) carries their position uncertainty.
 */
function burnRadius(f: ChartFeature, bbox: Rect, zones: Zone[], opts: BuildOptions): number {
  if (f.role !== "depth" || !f.hazard || f.geom.type !== "point") {
    return 0;
  }
  let sigmaP = 0;
  let covered = false;
  for (const { q, bbox: qb } of zones) {
    if (rectsOverlap(qb, bbox) && geomRectDistance(q.geom, bbox, 0) === 0) {
      covered = true;
      sigmaP = Math.max(sigmaP, sigmaFor(q.catzoc, 0, q, opts.quality).sigmaP);
    }
  }
  if (!covered) {
    sigmaP = sigmaFor(undefined, 0, {}, opts.quality).sigmaP;
  }
  return opts.k * sigmaP;
}

const NO_RINGS: Geom = { type: "polygon", polygons: [] };

/** Each feature's box and burn radius, the radius from its own cell's quality zones. */
function reaches(features: ChartFeature[], opts: BuildOptions): { bbox: Rect; radius: number }[] {
  const zonesByCell = new Map<number, Zone[]>();
  for (const f of features) {
    if (f.role === "quality") {
      const zones = zonesByCell.get(f.cellRef) ?? [];
      zones.push({ q: f, bbox: geomBounds(f.geom) });
      zonesByCell.set(f.cellRef, zones);
    }
  }
  return features.map((f) => {
    const bbox = geomBounds(f.geom);
    return { bbox, radius: burnRadius(f, bbox, zonesByCell.get(f.cellRef) ?? [], opts) };
  });
}

export function prepareItems(features: ChartFeature[], opts: BuildOptions): Item[] {
  const r = reaches(features, opts);
  return features.map((f, i) => {
    const { bbox, radius } = r[i] as { bbox: Rect; radius: number };
    const shape = f.geom.type === "polygon" ? f.geom.polygons.map(indexPolygon) : undefined;
    // Only coverage and quality rings are read again; an area's live on in `shape` alone.
    const rings = !shape || f.role === "coverage" || f.role === "quality";
    return { f: rings ? f : ({ ...f, geom: NO_RINGS } as ChartFeature), bbox, radius, shape };
  });
}

/** How far a cell's features reach, kept when the features themselves are let go. */
export interface CellReach {
  /** The union of its features' boxes. */
  box: Rect;
  /** Its widest burn radius, ground metres. */
  radius: number;
  /** The union of its coverage boxes; empty (inverted) without coverage. */
  coverage: Rect;
}

export function cellReach(features: ChartFeature[], opts: BuildOptions): CellReach {
  const reach: CellReach = { box: emptyRect(), radius: 0, coverage: emptyRect() };
  reaches(features, opts).forEach(({ bbox, radius }, i) => {
    const grow = (r: Rect) => {
      extendRect(r, bbox.minX, bbox.minY);
      extendRect(r, bbox.maxX, bbox.maxY);
    };
    grow(reach.box);
    if ((features[i] as ChartFeature).role === "coverage") {
      grow(reach.coverage);
    }
    reach.radius = Math.max(reach.radius, radius);
  });
  return reach;
}
