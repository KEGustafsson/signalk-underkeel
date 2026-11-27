import type { Rect } from "../foundation/geo";
import {
  emptyRect,
  extendRect,
  groundToMercator,
  maxAbsLat,
  rectContainsRect,
  rectsOverlap,
  tileRange,
  tileRect
} from "../foundation/geo";
import type { ChartFeature, DepthFeature, QualityFeature } from "../ingest/features";
import type { BuildOptions, Item } from "./build-items";
import { buildArea, DEFAULT_BUILD, deepestZoom, prepareItems, stopZoom } from "./build-items";
import type { ChartPosition, NodeColumns, NodeValues } from "./node-store";
import { combine, EMPTY, FLAGS, joinPosition, NO_DATA, NodeStore } from "./node-store";
import { chartPosition, NO_POSITION } from "./build-position";
import { dredgedCells, giveWay, isDredgedArea, sweptDepth, tileFlags } from "./give-way";
import { sigmaFor, SWEPT_SIGMA_D } from "./quality";
import type { ShoreIn, Tile } from "./shore";
import { SHORE_ABOVE, shoreAbove, shoreHere, shoreIn, shoreTiles } from "./shore";
import type { Hit } from "./tile-hits";
import { classify, hitsCover, isArea } from "./tile-hits";

/**
 * Builds the min-depth pyramid top-down (plan §4.3). A tile is subdivided
 * only where splitting can change a leaf's value; elsewhere the tile is
 * stored once and its values hold for all of it. At the leaf zoom every
 * feature touching the tile counts, so a leaf is never deeper than any
 * feature that reaches it.
 */

function depthOf(f: ChartFeature): number | undefined {
  return f.role === "depth" || f.role === "swept" ? f.depth : undefined;
}

interface Analysis {
  hits: Hit[];
  /** Highest rank (`rank`) whose coverage holds the whole tile. */
  bandFull: number | undefined;
  /** A larger-scale cell's coverage boundary crosses the tile. */
  coverageEdge: boolean;
  /** Catalogue index of the covering cell when it is advisory (Traficom WFS, Open Data Charts). */
  advisoryCell: number | undefined;
  needsSplit: boolean;
  /** The deepest zoom a feature here is drawn finely enough for (`splitZoom`). */
  finest: number;
  /** A dredged area's edge crosses the tile over its cell's depth area: split past the leaf. */
  sweptEdge: boolean;
  /** Dredged areas cover the whole tile, alone or side by side (`dredgedCells`). */
  dredgedCover: boolean;
  /** The depth sweeps guarantee over the whole tile (`sweptDepth`), if they cover it. */
  sweptCover: number | undefined;
  /**
   * A shore crosses the tile (`shore.ts`): its depth areas, in a cell that charts no land, and
   * their edges in it. The tile splits past the leaf, and is land where it stops.
   */
  shore: ShoreIn<Hit> | undefined;
}

/** Ground metres around the equator: a tile of zoom z is this / 2^z across, or less. */
const EQUATOR = 40_075_016.686;

/**
 * The zoom past which splitting tiles for feature `f` resolves nothing its
 * chart draws: its tiles are then no wider than 1 mm at its compilation
 * scale, its plotting accuracy (plan §4.3). A feature with no stated scale
 * (Traficom WFS, synthetic data) splits to the leaf zoom. A tile that stops
 * here takes the shallowest depth of all it holds, so it is never deeper.
 */
export function splitZoom(f: ChartFeature): number {
  return f.scale === undefined ? Infinity : Math.ceil(Math.log2(EQUATOR / (f.scale * 0.001)));
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
 * The precedence of a hit's cell: its usage band, or below every band for an advisory cell
 * (Traficom WFS, Open Data Charts), so any official ENC cell covering a tile takes it over.
 */
const rank = (h: Hit): number => (h.item.f.advisory === true ? 0 : h.item.f.band);

/**
 * Highest rank whose coverage holds the whole tile, by one polygon
 * or by adjacent cells of the band meeting along a shared edge.
 */
function coveredBand(coverage: Hit[], rect: Rect): number | undefined {
  const bands = [...new Set(coverage.map(rank))].sort((a, b) => b - a);
  return bands.find((band) => {
    const inBand = coverage.filter((h) => rank(h) === band);
    return inBand.some((h) => h.full) || (inBand.length > 1 && hitsCover(inBand, rect));
  });
}

function analyse(
  all: Hit[],
  rect: Rect,
  tileGround: number,
  /** At or past the leaf zoom: the shore gathered above the tile, undefined when none was. */
  leaf: { above: ShoreIn<Hit> | null | undefined } | undefined
): Analysis {
  const coverage = all.filter((h) => h.item.f.role === "coverage");
  const bandFull = coveredBand(coverage, rect);
  const floor = bandFull ?? -Infinity;
  const coverageEdge = coverage.some((h) => rank(h) > floor);
  // Lower-band cells are only gap fillers: once a larger scale covers the tile they drop out.
  const reaching = all.filter((h) => h.item.f.role !== "coverage" && rank(h) >= floor);
  const covers = (own: Hit[]): boolean => hitsCover(own, rect);
  const hits = giveWay(reaching, covers);
  // Dredged all over, by one area or by several meeting along a seam: DREDGED.
  const dredgedCover = dredgedCells(hits, covers).size > 0;
  const sweptCover = sweptDepth(hits, covers);
  const shallowest = minFullDepth(hits);
  const depthEdge = hits.some((h) => {
    const d = depthOf(h.item.f);
    return !h.full && d !== undefined && d < shallowest && h.item.radius <= BLUR_RATIO * tileGround;
  });
  // A dredged area's edge splits the tile while its cell's depth area is on it (`giveWay`),
  // and on past the leaf zoom (`edgeZoomFor`).
  const under = (h: Hit): boolean =>
    isDredgedArea(h) &&
    hits.some((g) => g.item.f.objectClass === "DEPARE" && g.item.f.cellRef === h.item.f.cellRef);
  const sweptEdge = hits.some((h) => under(h) && !h.full);
  const areaEdge =
    sweptEdge ||
    hits.some((h) => (h.item.f.role === "swept" || h.item.f.role === "unsurveyed") && !h.full);
  const advisoryCell = coverage.find((h) => rank(h) === bandFull && h.item.f.advisory)?.item.f
    .cellRef;
  // Above the leaf zoom a tile its depth areas leave part open splits for its depth's edge.
  const shore =
    leaf && advisoryCell !== undefined
      ? shoreIn(reaching.filter(isArea), rect, leaf.above, hitsCover)
      : undefined;
  const needsSplit =
    bandFull === undefined ||
    coverageEdge ||
    depthEdge ||
    areaEdge ||
    shore !== undefined ||
    qualityEdge(hits);
  let finest = -Infinity;
  for (const h of hits) {
    finest = Math.max(finest, splitZoom(h.item.f));
  }
  for (const h of coverage) {
    if (rank(h) >= floor) {
      finest = Math.max(finest, splitZoom(h.item.f));
    }
  }
  return {
    hits,
    bandFull,
    coverageEdge,
    advisoryCell,
    needsSplit,
    finest,
    sweptEdge,
    dredgedCover,
    sweptCover,
    shore
  };
}

/** σ of a feature the chart's drawing places (`chartPosition`); undefined for the survey's. */
const drawnSigma = (f: ChartFeature): number | undefined =>
  f.role === "depth" ? f.topoSigma : undefined;

/**
 * Whether a feature containing the whole tile gives every child all `f`
 * would: a depth no deeper, placed the same way (`chartPosition`), and when
 * drawn a σ no narrower. A sounding inside a shallower drawn area still
 * sets the depth its survey places, and spreads by the survey's σ.
 */
function dominated(f: DepthFeature, full: Hit[]): boolean {
  const sigma = f.topoSigma;
  return full.some(({ item: { f: g } }) => {
    const d = depthOf(g);
    if (d === undefined || d > f.depth) {
      return false;
    }
    const s = drawnSigma(g);
    return sigma === undefined ? s === undefined : s !== undefined && s >= sigma;
  });
}

/**
 * Features handed to the children. A partial depth feature that a feature
 * containing the whole tile dominates (`dominated`) cannot lower any
 * child's dMin or chart position, so it is dropped; dredged and swept
 * features stay for their flags. Where a larger-scale cell's coverage ends
 * inside the tile, the children may switch to that cell and drop the
 * current areas, so nothing is pruned.
 */
function forChildren(all: Hit[], a: Analysis): Item[] {
  const coverage = all.filter((h) => h.item.f.role === "coverage");
  const full = a.hits.filter((h) => h.full);
  const kept = a.hits.filter((h) => {
    const f = h.item.f;
    return a.coverageEdge || h.full || f.role !== "depth" || f.dredged || !dominated(f, full);
  });
  // A child lies inside its parent, so what contains the parent contains it.
  const pass = (h: Hit): Item => (h.full && !h.item.full ? { ...h.item, full: true } : h.item);
  return [...coverage.map(pass), ...kept.map(pass)];
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
  return zones.length > 0 && hitsCover(zones, rect);
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
    tileFlags(a.hits, {
      bandFull: a.bandFull,
      assessed,
      dredged: a.dredgedCover,
      swept: a.sweptCover !== undefined
    }) |
    (advisory ? FLAGS.NOT_FOR_NAVIGATION : 0) |
    (unsurveyed.length > 0 ? FLAGS.NO_COVERAGE : 0);
  const area = a.hits.some(isArea);
  // An advisory cell has no land objects: where no depth area reaches, the
  // tile is land, since the gap may hold a skerry left out. So is a tile its
  // depth areas leave part open (`shore.ts`): land of any width stays land.
  if (a.advisoryCell !== undefined && (!area || a.shore)) {
    return { dMin: -Infinity, sigmaD: 0, sigmaP: 0, flags, cellRef: a.advisoryCell };
  }
  if (!area || dMin === Infinity || unsurveyed.some((h) => h.full)) {
    return { ...NO_DATA, flags: flags | NO_DATA.flags };
  }
  const s = sigmas(a.hits, dMin, assessed, opts);
  // The sweep guarantees its own depth only; a rock or sounding charted
  // shallower inside it keeps the survey's σ.
  const sweptDecides = a.sweptCover !== undefined && a.sweptCover <= dMin;
  return {
    dMin,
    sigmaD: sweptDecides ? SWEPT_SIGMA_D : s.sigmaD,
    sigmaP: s.sigmaP,
    flags,
    cellRef
  };
}

export interface Evaluated {
  v: NodeValues;
  /** The node's chart position: widest σ and shallowest survey depth under it. */
  position: ChartPosition;
}

/**
 * Puts the nodes of tile (z, x, y) into `store` from elsewhere (`tile-reuse.ts`) and returns
 * the tile's values, or returns undefined and the tile is evaluated from `items`.
 */
export type TakeTile = (
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  rect: Rect,
  items: Item[]
) => Evaluated | undefined;

/** A local build's box (`BuildOptions.within`) and the area its tiles are built in. */
interface Box {
  inner: Rect;
  area: Rect;
}

/** `rect` holds ground inside `r`, not just a shared edge. */
const reaches = (rect: Rect, r: Rect): boolean =>
  rect.minX < r.maxX && r.minX < rect.maxX && rect.minY < r.maxY && r.minY < rect.maxY;

/** `rect` holds ground on both sides of an edge of `r`. */
const straddles = (rect: Rect, r: Rect): boolean => reaches(rect, r) && !rectContainsRect(r, rect);

/** `values` as tile `t` holds them: past the box with NO_COVERAGE. */
function boxed(values: NodeValues, box: Box | undefined, t: Tile): NodeValues {
  // Past the box a tile keeps its depth and σ, so it still spreads its risk into the box.
  return box && !rectContainsRect(box.inner, tileRect(...t))
    ? { ...values, flags: values.flags | FLAGS.NO_COVERAGE }
    : values;
}

/** Stores tile `t` as a leaf with `values`, read from the features `a` holds. */
function leaf(
  store: NodeStore,
  opts: BuildOptions,
  box: Box | undefined,
  t: Tile,
  a: Analysis,
  values: NodeValues
): Evaluated {
  const v = boxed(values, box, t);
  const position = chartPosition(a.hits, v, opts);
  store.add(...t, v, false, position);
  return { v, position };
}

/** Stores tile `t` as split into `children`: the shallowest depth, widest σ and every flag. */
function split(store: NodeStore, t: Tile, children: Evaluated[]): Evaluated {
  let v = EMPTY;
  let position = NO_POSITION;
  for (const child of children) {
    v = combine(v, child.v);
    position = joinPosition(position, child.position);
  }
  store.add(...t, v, true, position);
  return { v, position };
}

const CHILDREN = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1]
] as const;

/** The tiles under a shore leaf (`shore.ts`, `shoreTiles`): land, or the leaf's own reading. */
function shoreLeaf(
  store: NodeStore,
  opts: BuildOptions,
  box: Box | undefined,
  t: Tile,
  a: Analysis,
  shore: ShoreIn<Hit>
): Evaluated {
  const rect = tileRect(...t);
  const land = uniformValues(a, rect, opts);
  const water = uniformValues({ ...a, shore: undefined }, rect, opts);
  // A tile's chart position follows from the leaf's features and its values: found once each.
  const positions = new Map<number, ChartPosition>();
  const put = (tile: Tile, isLand: boolean): Evaluated => {
    const v = boxed(isLand ? land : water, box, tile);
    const key = (isLand ? 1 : 0) + (v.flags & FLAGS.NO_COVERAGE);
    const position = positions.get(key) ?? chartPosition(a.hits, v, opts);
    positions.set(key, position);
    store.add(...tile, v, false, position);
    return { v, position };
  };
  return shoreTiles(
    t,
    deepestZoom(opts),
    (z, x, y) => shoreHere(shore, tileRect(z, x, y), hitsCover),
    { leaf: put, split: (tile, children) => split(store, tile, children) }
  );
}

/**
 * A tile across the edge of the box or of its area splits to the leaf zoom, whatever its
 * scale: only a leaf may hold ground on both sides. No coarser tile then puts water in
 * the box under NO_COVERAGE, or carries a value far past the area from cells not read there.
 */
const acrossEdge = (box: Box, rect: Rect): boolean =>
  straddles(rect, box.inner) || straddles(rect, box.area);

/** Whether the tile at zoom `z` is stored as one value: at its stop zoom, or nothing to split for. */
const stops = (a: Analysis, z: number, opts: BuildOptions, edge: boolean): boolean =>
  z >= stopZoom(a.sweptEdge || a.shore !== undefined, opts) ||
  (!edge && a.shore === undefined && (!a.needsSplit || z >= a.finest));

function evaluate(
  store: NodeStore,
  opts: BuildOptions,
  box: Box | undefined,
  z: number,
  x: number,
  y: number,
  items: Item[],
  take?: TakeTile,
  shore?: ShoreIn<Hit> | null
): Evaluated {
  const rect = tileRect(z, x, y);
  const taken = take?.(store, z, x, y, rect, items);
  if (taken) {
    return taken;
  }
  const outside = box !== undefined && !reaches(rect, box.area);
  const all = outside ? [] : classify(items, rect);
  if (!all.some((h) => h.item.f.role === "coverage")) {
    store.add(z, x, y, NO_DATA, false, NO_POSITION);
    return { v: NO_DATA, position: NO_POSITION };
  }
  const tileGround = (rect.maxX - rect.minX) / groundToMercator(1, maxAbsLat(rect));
  // The shore is gathered once, SHORE_ABOVE the leaf zoom, for every leaf under the tile.
  const above =
    shore === undefined && z >= opts.leafZoom - SHORE_ABOVE
      ? shoreAbove(all.filter(isArea), rect, hitsCover)
      : shore;
  const a = analyse(all, rect, tileGround, z >= opts.leafZoom ? { above } : undefined);
  if (stops(a, z, opts, box !== undefined && acrossEdge(box, rect))) {
    return leaf(store, opts, box, [z, x, y], a, uniformValues(a, rect, opts));
  }
  // A swept area's edge in the tile too: every tile under it is read from its own features.
  if (a.shore && !a.sweptEdge) {
    return shoreLeaf(store, opts, box, [z, x, y], a, a.shore);
  }
  const passed = forChildren(all, a);
  return split(
    store,
    [z, x, y],
    CHILDREN.map(([dx, dy]) =>
      evaluate(store, opts, box, z + 1, 2 * x + dx, 2 * y + dy, passed, take, above)
    )
  );
}

export type { BuildOptions } from "./build-items";
export { DEFAULT_BUILD } from "./build-items";

/** A rectangle of minZoom root tiles: columns minX..maxX, rows minY..maxY. */
export interface RootRange {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The root tiles over the extent of the coverage items, or undefined without coverage. */
export function rootRange(items: readonly Item[], minZoom: number): RootRange | undefined {
  const extent = emptyRect();
  for (const it of items) {
    if (it.f.role === "coverage") {
      extendRect(extent, it.bbox.minX, it.bbox.minY);
      extendRect(extent, it.bbox.maxX, it.bbox.maxY);
    }
  }
  return extent.minX > extent.maxX ? undefined : tileRange(minZoom, extent);
}

/**
 * Evaluates the roots of `range`, column by column. Each root depends only on
 * the items that reach it, so the roots of any part of the range come out as
 * they do in a build of the whole. `take` may supply any tile's nodes instead.
 */
export function buildRoots(
  items: Item[],
  opts: BuildOptions,
  range: RootRange,
  take?: TakeTile
): NodeStore {
  const store = new NodeStore(opts.minZoom, deepestZoom(opts));
  const box = opts.within && { inner: opts.within, area: buildArea(opts.within) };
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      evaluate(store, opts, box, opts.minZoom, x, y, items, take);
    }
  }
  return store;
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
  const items = prepareItems(features, opts);
  const range = rootRange(items, opts.minZoom);
  return range ? buildRoots(items, opts, range) : new NodeStore(opts.minZoom, deepestZoom(opts));
}
