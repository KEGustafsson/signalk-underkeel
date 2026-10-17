import type { Rect } from "../foundation/geo";
import {
  emptyRect,
  expandRect,
  extendRect,
  groundToMercator,
  maxAbsLat,
  rectsOverlap,
  tileRange,
  tileRect
} from "../foundation/geo";
import { geomBounds, geomContainsRect, geomRectDistance } from "../foundation/geometry";
import type { ChartFeature, QualityFeature } from "../ingest/features";
import type { NodeValues } from "./node-store";
import { combine, EMPTY, FLAGS, NO_DATA, NodeStore } from "./node-store";
import type { QualityOptions } from "./quality";
import { DEFAULT_QUALITY, sigmaFor, SWEPT_SIGMA_D } from "./quality";

/**
 * Builds the min-depth pyramid top-down (plan §4.3). A tile is subdivided
 * only where splitting can change a leaf's value; elsewhere the tile is
 * stored once and its values hold for all of it. At the leaf zoom every
 * feature touching the tile counts, so a leaf is never deeper than any
 * feature that reaches it.
 */

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

interface Item {
  f: ChartFeature;
  bbox: Rect;
  /** Burn radius in ground metres (0 for areas). */
  radius: number;
}

interface Hit {
  item: Item;
  full: boolean;
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

function prepare(features: ChartFeature[], opts: BuildOptions): Item[] {
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
    return { f, bbox, radius: burnRadius(f, bbox, zonesByCell.get(f.cellRef) ?? [], opts) };
  });
}

function classify(items: Item[], rect: Rect): Hit[] {
  const scale = groundToMercator(1, maxAbsLat(rect));
  const hits: Hit[] = [];
  for (const item of items) {
    const r = item.radius * scale;
    if (!rectsOverlap(expandRect(rect, r), item.bbox)) {
      continue;
    }
    if (geomRectDistance(item.f.geom, rect, r) > r) {
      continue;
    }
    hits.push({ item, full: item.radius === 0 && geomContainsRect(item.f.geom, rect) });
  }
  return hits;
}

function depthOf(f: ChartFeature): number | undefined {
  return f.role === "depth" || f.role === "swept" ? f.depth : undefined;
}

interface Analysis {
  hits: Hit[];
  /** Highest usage band whose coverage contains the whole tile. */
  bandFull: number | undefined;
  /** Shallowest depth of an area that contains the whole tile. */
  shallowest: number;
  /** A larger-scale cell's coverage boundary crosses the tile. */
  coverageEdge: boolean;
  needsSplit: boolean;
}

function minFullDepth(hits: Hit[]): number {
  let d = Infinity;
  for (const h of hits) {
    const depth = depthOf(h.item.f);
    if (h.full && depth !== undefined) {
      d = Math.min(d, depth);
    }
  }
  return d;
}

/** A quality zone boundary crosses the tile and changes its CATZOC there. */
function qualityEdge(hits: Hit[]): boolean {
  const zones = hits.filter((h) => h.item.f.role === "quality");
  if (zones.length === 0) {
    return false;
  }
  const full = new Set(zones.filter((h) => h.full).map((h) => (h.item.f as QualityFeature).catzoc));
  return (
    full.size === 0 || zones.some((h) => !h.full && !full.has((h.item.f as QualityFeature).catzoc))
  );
}

/**
 * A burn disc this many times wider than a tile is already blurred far more
 * than the tile resolves, so its edge alone does not split the tile; the
 * tile then takes the disc's depth over its whole area, which is
 * conservative by at most one tile width.
 */
const BLUR_RATIO = 8;

function analyse(all: Hit[], tileGround: number): Analysis {
  let bandFull: number | undefined;
  for (const h of all) {
    if (h.item.f.role === "coverage" && h.full) {
      bandFull = Math.max(bandFull ?? -Infinity, h.item.f.band);
    }
  }
  const floor = bandFull ?? -Infinity;
  const coverageEdge = all.some(
    (h) => h.item.f.role === "coverage" && !h.full && h.item.f.band > floor
  );
  // Lower-band cells are only gap fillers: once a larger scale covers the tile they drop out.
  const hits = all.filter((h) => h.item.f.role !== "coverage" && h.item.f.band >= floor);
  const shallowest = minFullDepth(hits);
  const depthEdge = hits.some((h) => {
    const d = depthOf(h.item.f);
    return !h.full && d !== undefined && d < shallowest && h.item.radius <= BLUR_RATIO * tileGround;
  });
  const sweptEdge = hits.some((h) => h.item.f.role === "swept" && !h.full);
  const needsSplit =
    bandFull === undefined || coverageEdge || depthEdge || sweptEdge || qualityEdge(hits);
  return { hits, bandFull, shallowest, coverageEdge, needsSplit };
}

/**
 * Features handed to the children. A partial depth feature no shallower
 * than an area containing the whole tile cannot lower any child's dMin, so
 * it is dropped; dredged and swept features stay for their flags. Where a
 * larger-scale cell's coverage ends inside the tile, the children may
 * switch to that cell and drop the current areas, so nothing is pruned.
 */
function forChildren(all: Hit[], a: Analysis): Item[] {
  const coverageItems = all.filter((h) => h.item.f.role === "coverage").map((h) => h.item);
  const kept = a.hits.filter((h) => {
    const f = h.item.f;
    return a.coverageEdge || h.full || f.role !== "depth" || f.dredged || f.depth < a.shallowest;
  });
  return [...coverageItems, ...kept.map((h) => h.item)];
}

function sigmas(hits: Hit[], dMin: number, opts: BuildOptions): { sigmaP: number; sigmaD: number } {
  let sigmaP = 0;
  let sigmaD = 0;
  let fullQuality = false;
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "quality") {
      fullQuality ||= h.full;
      const s = sigmaFor(f.catzoc, dMin, f, opts.quality);
      sigmaP = Math.max(sigmaP, s.sigmaP);
      sigmaD = Math.max(sigmaD, s.sigmaD);
    }
  }
  if (!fullQuality) {
    const s = sigmaFor(undefined, dMin, {}, opts.quality);
    sigmaP = Math.max(sigmaP, s.sigmaP);
    sigmaD = Math.max(sigmaD, s.sigmaD);
  }
  return { sigmaP, sigmaD };
}

function flagsOf(hits: Hit[], bandFull: number | undefined, hasDepth: boolean): number {
  let flags = bandFull === undefined || !hasDepth ? FLAGS.NO_COVERAGE : 0;
  let assessed = false;
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "swept" && h.full) {
      flags |= FLAGS.SWEPT;
    } else if (f.role === "depth" && f.dredged && h.full) {
      flags |= FLAGS.DREDGED;
    } else if (f.role === "quality" && h.full && f.catzoc !== 6) {
      assessed = true;
    }
  }
  return assessed ? flags : flags | FLAGS.UNASSESSED;
}

/** Conservative values for a tile from every feature that reaches it. */
function uniformValues(a: Analysis, opts: BuildOptions): NodeValues {
  let dMin = Infinity;
  let cellRef = -1;
  for (const h of a.hits) {
    const d = depthOf(h.item.f);
    if (d !== undefined && d < dMin) {
      dMin = d;
      cellRef = h.item.f.cellRef;
    }
  }
  const hasDepth = dMin !== Infinity;
  const flags = flagsOf(a.hits, a.bandFull, hasDepth);
  if (!hasDepth) {
    return { ...NO_DATA, flags };
  }
  const s = sigmas(a.hits, dMin, opts);
  const sigmaD = flags & FLAGS.SWEPT ? SWEPT_SIGMA_D : s.sigmaD;
  return {
    dMin: flags & FLAGS.NO_COVERAGE ? -Infinity : dMin,
    sigmaD,
    sigmaP: s.sigmaP,
    flags,
    cellRef
  };
}

function evaluate(
  store: NodeStore,
  opts: BuildOptions,
  z: number,
  x: number,
  y: number,
  items: Item[]
): NodeValues {
  const rect = tileRect(z, x, y);
  const all = classify(items, rect);
  if (!all.some((h) => h.item.f.role === "coverage")) {
    store.add(z, x, y, NO_DATA, false);
    return NO_DATA;
  }
  const tileGround = (rect.maxX - rect.minX) / groundToMercator(1, maxAbsLat(rect));
  const a = analyse(all, tileGround);
  if (!a.needsSplit || z === opts.leafZoom) {
    const v = uniformValues(a, opts);
    store.add(z, x, y, v, false);
    return v;
  }
  const passed = forChildren(all, a);
  let v = EMPTY;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
  ] as const) {
    v = combine(v, evaluate(store, opts, z + 1, 2 * x + dx, 2 * y + dy, passed));
  }
  store.add(z, x, y, v, true);
  return v;
}

/**
 * Builds the pyramid over the extent of all coverage features, one root per
 * minZoom tile. Without coverage the store is empty and every query is
 * NO_COVERAGE.
 */
export function buildPyramid(
  features: ChartFeature[],
  options: Partial<BuildOptions> = {}
): NodeStore {
  const opts = { ...DEFAULT_BUILD, ...options };
  const store = new NodeStore(opts.minZoom, opts.leafZoom);
  const items = prepare(features, opts);
  const extent = emptyRect();
  for (const it of items) {
    if (it.f.role === "coverage") {
      extendRect(extent, it.bbox.minX, it.bbox.minY);
      extendRect(extent, it.bbox.maxX, it.bbox.maxY);
    }
  }
  if (extent.minX > extent.maxX) {
    return store;
  }
  const range = tileRange(opts.minZoom, extent);
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      evaluate(store, opts, opts.minZoom, x, y, items);
    }
  }
  return store;
}
