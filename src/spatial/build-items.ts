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
  sigmaP: number;
}

/** Only point hazards and soundings are burned. */
const burns = (f: ChartFeature): boolean =>
  f.role === "depth" && f.hazard === true && f.geom.type === "point";

/**
 * Burn radius of a point hazard or sounding: k·σP of the quality zones of
 * its own cell that contain it. Lines and areas are not widened; the query
 * buffer (plan §4.7) carries their position uncertainty.
 */
function burnRadius(f: ChartFeature, bbox: Rect, zones: Zone[], opts: BuildOptions): number {
  if (!burns(f)) {
    return 0;
  }
  let sigmaP = 0;
  let covered = false;
  for (const z of zones) {
    if (rectsOverlap(z.bbox, bbox) && geomRectDistance(z.q.geom, bbox, 0) === 0) {
      covered = true;
      sigmaP = Math.max(sigmaP, z.sigmaP);
    }
  }
  if (!covered) {
    sigmaP = sigmaFor(undefined, 0, {}, opts.quality).sigmaP;
  }
  return opts.k * sigmaP;
}

/** No burn radius in a cell with these zones exceeds this. */
function widestRadius(zones: Zone[], opts: BuildOptions): number {
  const uncovered = sigmaFor(undefined, 0, {}, opts.quality).sigmaP;
  return opts.k * zones.reduce((m, z) => Math.max(m, z.sigmaP), uncovered);
}

const NO_RINGS: Geom = { type: "polygon", polygons: [] };

/** Accepts a feature by its box and burn radius. */
type Keep = (bbox: Rect, radius: number) => boolean;

/**
 * Each feature's box and burn radius, the radius from its own cell's quality
 * zones; undefined for a feature `keep` rejects. A point that cannot reach
 * even at its cell's widest radius is rejected before its zones are tested.
 */
function reaches(
  features: ChartFeature[],
  opts: BuildOptions,
  keep?: Keep
): ({ bbox: Rect; radius: number } | undefined)[] {
  const zonesByCell = new Map<number, Zone[]>();
  for (const f of features) {
    if (f.role === "quality") {
      const zones = zonesByCell.get(f.cellRef) ?? [];
      const sigmaP = sigmaFor(f.catzoc, 0, f, opts.quality).sigmaP;
      zones.push({ q: f, bbox: geomBounds(f.geom), sigmaP });
      zonesByCell.set(f.cellRef, zones);
    }
  }
  const widest = new Map<number, number>();
  for (const [cellRef, zones] of zonesByCell) {
    widest.set(cellRef, widestRadius(zones, opts));
  }
  return features.map((f) => {
    const bbox = geomBounds(f.geom);
    const most = burns(f) ? (widest.get(f.cellRef) ?? widestRadius([], opts)) : 0;
    if (keep && !keep(bbox, most)) {
      return undefined;
    }
    const radius = burnRadius(f, bbox, zonesByCell.get(f.cellRef) ?? [], opts);
    return keep && !keep(bbox, radius) ? undefined : { bbox, radius };
  });
}

/**
 * The features as items. With `keep`, only the features it accepts by box and
 * burn radius are indexed; a region build drops those that cannot reach it.
 */
export function prepareItems(features: ChartFeature[], opts: BuildOptions, keep?: Keep): Item[] {
  const r = reaches(features, opts, keep);
  const out: Item[] = [];
  features.forEach((f, i) => {
    const reach = r[i];
    if (!reach) {
      return;
    }
    const { bbox, radius } = reach;
    const shape = f.geom.type === "polygon" ? f.geom.polygons.map(indexPolygon) : undefined;
    // Only coverage and quality rings are read again; an area's live on in `shape` alone.
    const rings = !shape || f.role === "coverage" || f.role === "quality";
    out.push({ f: rings ? f : ({ ...f, geom: NO_RINGS } as ChartFeature), bbox, radius, shape });
  });
  return out;
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
  reaches(features, opts).forEach((r, i) => {
    const { bbox, radius } = r as { bbox: Rect; radius: number };
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
