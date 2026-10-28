import type { Rect } from "../foundation/geo";
import {
  emptyRect,
  expandRect,
  extendRect,
  groundToMercator,
  maxAbsLat,
  rectsOverlap
} from "../foundation/geo";
import type { Geom } from "../foundation/geometry";
import { geomBounds, geomRectDistance } from "../foundation/geometry";
import type { ChartFeature, QualityFeature } from "../ingest/features";
import { MAX_CHART_BUFFER } from "./chart-position";
import type { PolygonIndex } from "./polygon-index";
import { indexPolygon, polygonsTouchPoint } from "./polygon-index";
import type { QualityOptions } from "./quality";
import { DEFAULT_QUALITY, sigmaFor } from "./quality";

/** What the pyramid build reads of each feature: its box, burn radius and indexed polygons. */

export interface BuildOptions {
  minZoom: number;
  leafZoom: number;
  /** Point hazards and soundings outside assessed water are burned within k·σP of their position. */
  k: number;
  quality: QualityOptions;
  /**
   * The Mercator box around the vessel a local build serves. Tiles are built
   * out to `buildArea` of it, so a charted hazard just past the box still
   * spreads its risk into it, but every tile not wholly inside the box
   * carries NO_COVERAGE: nothing outside it reads as charted water
   * (invariants 3 and 4). Tiles further out are no coverage, never water.
   */
  within?: Rect;
}

/**
 * Ground metres past the box a local build gives tiles their values: the
 * widest chart position reach (`MAX_CHART_BUFFER`), rounded up to a km. A
 * tile further out reaches a footprint in the box only within its buffer,
 * which then also meets the NO_COVERAGE of the tiles between.
 */
export const BOX_REACH = Math.ceil(MAX_CHART_BUFFER / 1000) * 1000;

/** The Mercator rectangle a build within `box` gives values: `box` grown by BOX_REACH. */
export function buildArea(box: Rect): Rect {
  return expandRect(box, groundToMercator(BOX_REACH, maxAbsLat(box)));
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
  /** The zone's polygons, indexed when a point first falls in its box. */
  shape?: PolygonIndex[];
}

/** A cell's quality zones filed by box on a uniform grid: a point reads the zones of its grid cell. */
interface ZoneGrid {
  box: Rect;
  size: number;
  cells: Zone[][];
}

/** Monotone in `v`, so a zone box holding `v` is filed under its slot. */
function slot(g: ZoneGrid, v: number, min: number, max: number): number {
  return Math.min(g.size - 1, Math.max(0, Math.floor(((v - min) / (max - min || 1)) * g.size)));
}

function zoneGrid(zones: Zone[]): ZoneGrid {
  // An empty zone's box is inverted and overlaps nothing.
  const filed = zones.filter((z) => z.bbox.minX <= z.bbox.maxX && z.bbox.minY <= z.bbox.maxY);
  const box = emptyRect();
  for (const z of filed) {
    extendRect(box, z.bbox.minX, z.bbox.minY);
    extendRect(box, z.bbox.maxX, z.bbox.maxY);
  }
  const size = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(filed.length))));
  const g: ZoneGrid = { box, size, cells: Array.from({ length: size * size }, () => []) };
  for (const z of filed) {
    const x0 = slot(g, z.bbox.minX, box.minX, box.maxX);
    const x1 = slot(g, z.bbox.maxX, box.minX, box.maxX);
    const y1 = slot(g, z.bbox.maxY, box.minY, box.maxY);
    for (let y = slot(g, z.bbox.minY, box.minY, box.maxY); y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        (g.cells[y * size + x] as Zone[]).push(z);
      }
    }
  }
  return g;
}

/** Every zone whose box holds (x, y), and maybe others. */
function zonesAt(g: ZoneGrid, x: number, y: number): Zone[] {
  const b = g.box;
  if (!(x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY)) {
    return [];
  }
  return g.cells[slot(g, y, b.minY, b.maxY) * g.size + slot(g, x, b.minX, b.maxX)] as Zone[];
}

/** `geomRectDistance(z.q.geom, bbox, 0) === 0` for a point's box, through the indexed polygons. */
function touches(z: Zone, bbox: Rect): boolean {
  const geom = z.q.geom;
  if (geom.type !== "polygon") {
    return geomRectDistance(geom, bbox, 0) === 0;
  }
  z.shape ??= geom.polygons.map(indexPolygon);
  return polygonsTouchPoint(z.shape, bbox.minX, bbox.minY);
}

/** Only point hazards and soundings are burned. */
const burns = (f: ChartFeature): boolean =>
  f.role === "depth" && f.hazard === true && f.geom.type === "point";

/**
 * Burn radius of a point hazard or sounding. In assessed water it is 0: the
 * leaf it falls in spreads it by its survey's σP at query time, graded by
 * distance (`chart-position.ts`), as areas and lines are. Unassessed water
 * spreads nothing at query time, so a point there, or in a cell of its own
 * zone set reaching an unassessed zone, is burned within k·σP of the widest
 * zone containing it, the unassessed σP when none does.
 */
function burnRadius(
  f: ChartFeature,
  bbox: Rect,
  zones: ZoneGrid | undefined,
  opts: BuildOptions
): number {
  if (!burns(f)) {
    return 0;
  }
  let sigmaP = 0;
  let covered = false;
  let unassessed = false;
  // A point's box is the point; the result does not depend on the zones' order.
  for (const z of zones ? zonesAt(zones, bbox.minX, bbox.minY) : []) {
    if (rectsOverlap(z.bbox, bbox) && touches(z, bbox)) {
      covered = true;
      unassessed ||= z.q.catzoc === 6 || z.q.advisory === true;
      sigmaP = Math.max(sigmaP, z.sigmaP);
    }
  }
  if (covered && !unassessed) {
    return 0;
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

interface Reach {
  bbox: Rect;
  radius: number;
  /** A quality zone's polygons when a point's test indexed them. */
  shape?: PolygonIndex[];
}

/**
 * Each feature's box and burn radius, the radius from its own cell's quality
 * zones; undefined for a feature `keep` rejects. A point that cannot reach
 * even at its cell's widest radius is rejected before its zones are tested.
 */
function reaches(features: ChartFeature[], opts: BuildOptions, keep?: Keep): (Reach | undefined)[] {
  const zonesByCell = new Map<number, Zone[]>();
  const zoneOf = new Map<ChartFeature, Zone>();
  for (const f of features) {
    if (f.role === "quality") {
      const zones = zonesByCell.get(f.cellRef) ?? [];
      const sigmaP = sigmaFor(f.catzoc, 0, f, opts.quality).sigmaP;
      const zone: Zone = { q: f, bbox: geomBounds(f.geom), sigmaP };
      zones.push(zone);
      zoneOf.set(f, zone);
      zonesByCell.set(f.cellRef, zones);
    }
  }
  const widest = new Map<number, number>();
  const grids = new Map<number, ZoneGrid>();
  for (const [cellRef, zones] of zonesByCell) {
    widest.set(cellRef, widestRadius(zones, opts));
    grids.set(cellRef, zoneGrid(zones));
  }
  const out = features.map((f): Reach | undefined => {
    const bbox = geomBounds(f.geom);
    const most = burns(f) ? (widest.get(f.cellRef) ?? widestRadius([], opts)) : 0;
    if (keep && !keep(bbox, most)) {
      return undefined;
    }
    const radius = burnRadius(f, bbox, grids.get(f.cellRef), opts);
    return keep && !keep(bbox, radius) ? undefined : { bbox, radius };
  });
  // Once every point is tested: a zone is indexed by the first point in its box.
  features.forEach((f, i) => {
    const r = out[i];
    if (r) {
      r.shape = zoneOf.get(f)?.shape;
    }
  });
  return out;
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
    const shape =
      reach.shape ?? (f.geom.type === "polygon" ? f.geom.polygons.map(indexPolygon) : undefined);
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
