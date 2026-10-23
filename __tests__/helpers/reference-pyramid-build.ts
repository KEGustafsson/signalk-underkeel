/**
 * The pyramid builder as it was before the build-speed work (IX-1), kept so
 * tests can prove the current builder produces the same nodes. Its rules
 * follow the current build: graded chart position (plan §4.3) burns only
 * points outside assessed water and keeps each node's chart position.
 */

import type { Rect } from "../../src/foundation/geo";
import {
  emptyRect,
  expandRect,
  extendRect,
  groundToMercator,
  MERCATOR_HALF_WORLD,
  maxAbsLat,
  rectsOverlap,
  tileRange,
  tileRect
} from "../../src/foundation/geo";
import {
  areasCoverRect,
  geomBounds,
  geomContainsRect,
  geomRectDistance
} from "../../src/foundation/geometry";
import type { ChartFeature, QualityFeature } from "../../src/ingest/features";
import type { ChartPosition, NodeValues } from "../../src/spatial/node-store";
import { combine, EMPTY, FLAGS, NO_DATA, NodeStore } from "../../src/spatial/node-store";
import type { QualityOptions } from "../../src/spatial/quality";
import { DEFAULT_QUALITY, sigmaFor, SWEPT_SIGMA_D } from "../../src/spatial/quality";

/**
 * Builds the min-depth pyramid top-down (plan §4.3). A tile is subdivided
 * only where splitting can change a leaf's value; elsewhere the tile is
 * stored once and its values hold for all of it. At the leaf zoom every
 * feature touching the tile counts, so a leaf is never deeper than any
 * feature that reaches it.
 */

interface BuildOptions {
  minZoom: number;
  leafZoom: number;
  /** Point hazards and soundings are burned within k·σP of their position. */
  k: number;
  quality: QualityOptions;
}

const DEFAULT_BUILD: BuildOptions = {
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
  let unassessed = false;
  for (const { q, bbox: qb } of zones) {
    if (rectsOverlap(qb, bbox) && geomRectDistance(q.geom, bbox, 0) === 0) {
      covered = true;
      unassessed ||= q.catzoc === 6 || q.advisory === true;
      sigmaP = Math.max(sigmaP, sigmaFor(q.catzoc, 0, q, opts.quality).sigmaP);
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

/** Containment is tested this far, in Mercator metres, inside the world's ±180° edge. */
const WORLD_EDGE_INSET = 1e-3;

/**
 * The tile as containment sees it. Nothing lies past ±180°, so a cell whose
 * edge runs along it holds a tile on that edge; read as is, the shared edge
 * left every leaf there uncovered. A real gap past 180° is still found by
 * queries, which walk the tiles at the other end of the world.
 */
function inWorld(rect: Rect): Rect {
  const edge = MERCATOR_HALF_WORLD - WORLD_EDGE_INSET;
  return {
    minX: Math.max(rect.minX, -edge),
    minY: rect.minY,
    maxX: Math.min(rect.maxX, edge),
    maxY: rect.maxY
  };
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
    hits.push({ item, full: item.radius === 0 && geomContainsRect(item.f.geom, inWorld(rect)) });
  }
  return hits;
}

function depthOf(f: ChartFeature): number | undefined {
  return f.role === "depth" || f.role === "swept" ? f.depth : undefined;
}

interface Analysis {
  hits: Hit[];
  /** Highest usage band whose coverage holds the whole tile. */
  bandFull: number | undefined;
  /** Shallowest depth of an area that contains the whole tile. */
  shallowest: number;
  /** A larger-scale cell's coverage boundary crosses the tile. */
  coverageEdge: boolean;
  /** Catalogue index of the covering cell when it is advisory (Traficom WFS). */
  advisoryCell: number | undefined;
  needsSplit: boolean;
  /** The deepest zoom any feature here is drawn finely enough for. */
  finest: number;
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

/**
 * Highest usage band whose coverage holds the whole tile, by one polygon
 * or by adjacent cells of the band meeting along a shared edge.
 */
function coveredBand(coverage: Hit[], rect: Rect): number | undefined {
  const bands = [...new Set(coverage.map((h) => h.item.f.band))].sort((a, b) => b - a);
  return bands.find((band) => {
    const inBand = coverage.filter((h) => h.item.f.band === band);
    return (
      inBand.some((h) => h.full) ||
      (inBand.length > 1 &&
        areasCoverRect(
          inBand.map((h) => h.item.f.geom),
          inWorld(rect)
        ))
    );
  });
}

function analyse(all: Hit[], rect: Rect, tileGround: number): Analysis {
  const coverage = all.filter((h) => h.item.f.role === "coverage");
  const bandFull = coveredBand(coverage, rect);
  const floor = bandFull ?? -Infinity;
  const coverageEdge = coverage.some((h) => h.item.f.band > floor);
  // Lower-band cells are only gap fillers: once a larger scale covers the tile they drop out.
  const hits = all.filter((h) => h.item.f.role !== "coverage" && h.item.f.band >= floor);
  const shallowest = minFullDepth(hits);
  const depthEdge = hits.some((h) => {
    const d = depthOf(h.item.f);
    return !h.full && d !== undefined && d < shallowest && h.item.radius <= BLUR_RATIO * tileGround;
  });
  const areaEdge = hits.some(
    (h) => (h.item.f.role === "swept" || h.item.f.role === "unsurveyed") && !h.full
  );
  const needsSplit =
    bandFull === undefined || coverageEdge || depthEdge || areaEdge || qualityEdge(hits);
  const advisoryCell = coverage.find((h) => h.item.f.band === bandFull && h.item.f.advisory)?.item.f
    .cellRef;
  // A tile no wider than 1 mm at the finest compilation scale here resolves all it draws.
  const zoomOf = (f: ChartFeature) =>
    f.scale === undefined ? Infinity : Math.ceil(Math.log2(40_075_016.686 / (f.scale * 0.001)));
  const finest = Math.max(
    -Infinity,
    ...hits.map((h) => zoomOf(h.item.f)),
    ...coverage.filter((h) => h.item.f.band >= floor).map((h) => zoomOf(h.item.f))
  );
  return { hits, bandFull, shallowest, coverageEdge, advisoryCell, needsSplit, finest };
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

function isQuality(h: Hit): h is Hit & { item: { f: QualityFeature } } {
  return h.item.f.role === "quality";
}

/**
 * Whether assessed quality zones cover the whole tile. At a boundary
 * between two zones neither contains the leaf, but together they do.
 */
function assessedCover(hits: Hit[], rect: Rect): boolean {
  const zones = hits.filter(isQuality).filter((h) => h.item.f.catzoc !== 6);
  if (zones.some((h) => h.full)) {
    return true;
  }
  return (
    zones.length > 0 &&
    areasCoverRect(
      zones.map((h) => h.item.f.geom),
      inWorld(rect)
    )
  );
}

/**
 * σ from the worst quality zone reaching the tile; where the zones do not
 * cover the whole tile, the unassessed σ is taken too.
 */
function sigmas(
  hits: Hit[],
  dMin: number,
  covered: boolean,
  opts: BuildOptions
): { sigmaP: number; sigmaD: number } {
  let sigmaP = 0;
  let sigmaD = 0;
  let fullQuality = covered;
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

function flagsOf(hits: Hit[], bandFull: number | undefined, assessed: boolean): number {
  let flags = bandFull === undefined ? FLAGS.NO_COVERAGE : 0;
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "swept" && h.full) {
      flags |= FLAGS.SWEPT;
    } else if (f.role === "depth" && f.dredged && h.full) {
      flags |= FLAGS.DREDGED;
    }
  }
  return assessed ? flags : flags | FLAGS.UNASSESSED;
}

function isArea(h: Hit): boolean {
  const f = h.item.f;
  return f.role === "depth" && !f.hazard && f.geom.type === "polygon";
}

/**
 * Conservative values for a tile from every feature that reaches it. A
 * leaf only partly inside coverage, or partly in an unsurveyed area, keeps
 * the charted depth of the rest and carries NO_COVERAGE, so a rock there
 * is not hidden by the gap beside it. A tile inside an unsurveyed area, or
 * one no depth area reaches, is NO_DATA: a sounding's burn disc does not
 * make it water.
 */
function uniformValues(a: Analysis, rect: Rect, opts: BuildOptions): NodeValues {
  let dMin = Infinity;
  let cellRef = -1;
  for (const h of a.hits) {
    const d = depthOf(h.item.f);
    if (d !== undefined && d < dMin) {
      dMin = d;
      cellRef = h.item.f.cellRef;
    }
  }
  const assessed = assessedCover(a.hits, rect);
  const advisory = a.advisoryCell !== undefined || a.hits.some((h) => h.item.f.advisory);
  const unsurveyed = a.hits.filter((h) => h.item.f.role === "unsurveyed");
  const flags =
    flagsOf(a.hits, a.bandFull, assessed) |
    (advisory ? FLAGS.NOT_FOR_NAVIGATION : 0) |
    (unsurveyed.length > 0 ? FLAGS.NO_COVERAGE : 0);
  const area = a.hits.some(isArea);
  // An advisory cell has no land objects: where no depth area reaches, the
  // tile is land, since the gap may hold a skerry left out.
  if (a.advisoryCell !== undefined && !area) {
    return { dMin: -Infinity, sigmaD: 0, sigmaP: 0, flags, cellRef: a.advisoryCell };
  }
  if (!area || dMin === Infinity || unsurveyed.some((h) => h.full)) {
    return { ...NO_DATA, flags: flags | NO_DATA.flags };
  }
  const s = sigmas(a.hits, dMin, assessed, opts);
  // The sweep guarantees its own depth only; a rock or sounding charted
  // shallower inside it keeps the survey's σ.
  const sweptDecides = a.hits.some(
    (h) => h.full && h.item.f.role === "swept" && h.item.f.depth <= dMin
  );
  return {
    dMin,
    sigmaD: sweptDecides ? SWEPT_SIGMA_D : s.sigmaD,
    sigmaP: s.sigmaP,
    flags,
    cellRef
  };
}

/**
 * Chart position σP of a leaf: the widest of the assessed, non-advisory
 * quality zones reaching it, however much of it they cover.
 */
function surveySigma(hits: Hit[], opts: BuildOptions): number {
  let sigmaP = 0;
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "quality" && f.catzoc !== 6 && !f.advisory) {
      sigmaP = Math.max(sigmaP, sigmaFor(f.catzoc, 0, f, opts.quality).sigmaP);
    }
  }
  return sigmaP;
}

/**
 * A leaf's chart position: survey σ with the depth the survey places
 * (soundings, point dangers), and the drawing's σ with the depth it places
 * (land, depth areas).
 */
function chartPosition(hits: Hit[], v: NodeValues, opts: BuildOptions): ChartPosition {
  const survey = surveySigma(hits, opts);
  if (v.flags & FLAGS.NO_DEPTH) {
    return { ...NO_POSITION, surveySigmaP: survey };
  }
  let topo = 0;
  let drawn = Infinity;
  let bathy = Infinity;
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "depth" && f.topoSigma !== undefined) {
      topo = Math.max(topo, f.topoSigma);
      drawn = Math.min(drawn, f.depth);
    } else if (f.role === "depth" || f.role === "swept") {
      bathy = Math.min(bathy, f.depth);
    }
  }
  if (topo === 0) {
    return { surveySigmaP: survey, topoSigmaP: 0, bathyDMin: v.dMin, topoDMin: Infinity };
  }
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "position") {
      if (f.posacc !== undefined) {
        topo = Math.max(topo, f.posacc / 2);
      }
      if (f.lowAccuracy) {
        const unsurveyed = survey > 0 ? survey : sigmaFor(undefined, 0, {}, opts.quality).sigmaP;
        // Read as drawn from a source four times smaller in scale (`NOT_SURVEYED_SCALE`).
        topo = Math.max(topo, f.scale === undefined ? unsurveyed : 4 * ((f.scale * 0.001) / 2));
      }
    }
  }
  return { surveySigmaP: survey, topoSigmaP: topo, bathyDMin: bathy, topoDMin: drawn };
}

interface Evaluated {
  v: NodeValues;
  /** The widest σ and shallowest survey depth under the node. */
  position: ChartPosition;
}

const NO_POSITION: ChartPosition = {
  surveySigmaP: 0,
  topoSigmaP: 0,
  bathyDMin: Infinity,
  topoDMin: Infinity
};

function evaluate(
  store: NodeStore,
  opts: BuildOptions,
  z: number,
  x: number,
  y: number,
  items: Item[]
): Evaluated {
  const rect = tileRect(z, x, y);
  const all = classify(items, rect);
  if (!all.some((h) => h.item.f.role === "coverage")) {
    store.add(z, x, y, NO_DATA, false, NO_POSITION);
    return { v: NO_DATA, position: NO_POSITION };
  }
  const tileGround = (rect.maxX - rect.minX) / groundToMercator(1, maxAbsLat(rect));
  const a = analyse(all, rect, tileGround);
  if (!a.needsSplit || z >= Math.min(opts.leafZoom, a.finest)) {
    const v = uniformValues(a, rect, opts);
    const position = chartPosition(a.hits, v, opts);
    store.add(z, x, y, v, false, position);
    return { v, position };
  }
  const passed = forChildren(all, a);
  let v = EMPTY;
  let position = NO_POSITION;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
  ] as const) {
    const child = evaluate(store, opts, z + 1, 2 * x + dx, 2 * y + dy, passed);
    v = combine(v, child.v);
    position = {
      surveySigmaP: Math.max(position.surveySigmaP, child.position.surveySigmaP),
      topoSigmaP: Math.max(position.topoSigmaP, child.position.topoSigmaP),
      bathyDMin: Math.min(position.bathyDMin, child.position.bathyDMin),
      topoDMin: Math.min(position.topoDMin, child.position.topoDMin)
    };
  }
  store.add(z, x, y, v, true, position);
  return { v, position };
}

/**
 * Builds the pyramid over the extent of all coverage features, one root per
 * minZoom tile. Without coverage the store is empty and every query is
 * NO_COVERAGE.
 */
export function referenceBuildPyramid(
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
