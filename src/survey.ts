import { EARTH_RADIUS } from "./foundation/geo";
import type { Bbox } from "./ingest/wfs";

/**
 * The depth survey (signalk-route-planner's plan §4.2): a coarse grid over a region larger than
 * any planning box holds, each cell the deepest charted depth of the depth and dredged areas
 * touching it. The planner finds a corridor on it and asks for a planning box of the corridor
 * alone. It only chooses where to look: optimistic by design, it is never a verdict, and
 * nothing it says reaches a route without the route check on the corridor's index.
 */

/** A coarse depth grid over a region. */
export interface Survey {
  /** The grid's extent, [west, south, east, north]: the region rounded out to whole cells. */
  readonly bbox: Bbox;
  readonly cols: number;
  readonly rows: number;
  /** Cell side, metres: north–south, and east–west at the grid's middle latitude. */
  readonly cellMetres: number;
  /**
   * The deepest charted depth touching each cell, metres below chart datum; NaN where no depth
   * area does (land, or past the charts). Row-major, row 0 the southernmost, column 0 the
   * westernmost.
   */
  readonly depth: Float32Array;
}

/** No cell is finer than this, metres. */
export const SURVEY_MIN_CELL_M = 50;
/** A grid has at most this many cells (4 MB of depths); a coarser cell keeps it within. */
export const SURVEY_MAX_CELLS = 1_000_000;
/** A tile of the download spans at most this much, degrees, north–south and east–west. */
const TILE_LAT = 0.1;
const TILE_LON = 0.2;

const M_PER_DEG = (EARTH_RADIUS * Math.PI) / 180;

/** The cell size in degrees: north–south, east–west. */
export function cellDegrees(g: Pick<Survey, "bbox" | "cellMetres">): [number, number] {
  const mid = ((g.bbox[1] + g.bbox[3]) / 2) * (Math.PI / 180);
  const dLat = g.cellMetres / M_PER_DEG;
  return [dLat, g.cellMetres / (M_PER_DEG * Math.cos(mid))];
}

/** An empty grid over `region` of cells `cellMetres` on a side, coarser when that is too many. */
export function surveyGrid(region: Bbox, cellMetres: number): Survey {
  const [w, s, e, n] = region;
  const cos = Math.cos(((s + n) / 2) * (Math.PI / 180));
  const dims = (c: number): [number, number] => [
    Math.max(1, Math.ceil(((e - w) * M_PER_DEG * cos) / c)),
    Math.max(1, Math.ceil(((n - s) * M_PER_DEG) / c))
  ];
  let cell = Math.max(SURVEY_MIN_CELL_M, cellMetres);
  let [cols, rows] = dims(cell);
  while (cols * rows > SURVEY_MAX_CELLS) {
    cell *= Math.max(1.01, Math.sqrt((cols * rows) / SURVEY_MAX_CELLS));
    [cols, rows] = dims(cell);
  }
  const [dLat, dLon] = cellDegrees({ bbox: region, cellMetres: cell });
  return {
    bbox: [w, s, w + cols * dLon, s + rows * dLat],
    cols,
    rows,
    cellMetres: cell,
    depth: new Float32Array(cols * rows).fill(Number.NaN)
  };
}

/** A block of whole cells, `[c0, r0, c1, r1)`, and the box it covers. */
export interface SurveyTile {
  range: [number, number, number, number];
  bbox: Bbox;
}

/** The grid cut into tiles of whole cells, each within TILE_LAT by TILE_LON degrees. */
export function surveyTiles(g: Survey): SurveyTile[] {
  const [dLat, dLon] = cellDegrees(g);
  const tc = Math.max(1, Math.floor(TILE_LON / dLon));
  const tr = Math.max(1, Math.floor(TILE_LAT / dLat));
  const [w, s] = g.bbox;
  const out: SurveyTile[] = [];
  for (let r0 = 0; r0 < g.rows; r0 += tr) {
    for (let c0 = 0; c0 < g.cols; c0 += tc) {
      const c1 = Math.min(g.cols, c0 + tc);
      const r1 = Math.min(g.rows, r0 + tr);
      out.push({
        range: [c0, r0, c1, r1],
        bbox: [w + c0 * dLon, s + r0 * dLat, w + c1 * dLon, s + r1 * dLat]
      });
    }
  }
  return out;
}

type Ring = readonly (readonly number[])[];

/**
 * Raises to `value` every cell of `range` the polygon `rings` (outer ring, then holes; lon/lat)
 * touches: the cells its edges pass through and those whose centres lie inside it.
 */
export function markPolygon(
  g: Survey,
  rings: readonly Ring[],
  value: number,
  range: readonly [number, number, number, number] = [0, 0, g.cols, g.rows]
): void {
  const [dLat, dLon] = cellDegrees(g);
  const [w, s] = g.bbox;
  const [c0, r0, c1, r1] = range;
  const mark = (c: number, r: number): void => {
    if (c >= c0 && c < c1 && r >= r0 && r < r1) {
      const i = r * g.cols + c;
      if (!((g.depth[i] as number) >= value)) {
        g.depth[i] = value;
      }
    }
  };
  // The x of each edge crossing a row's centre line, by row.
  const crossings = new Map<number, number[]>();
  for (const ring of rings) {
    for (let k = 0; k + 1 < ring.length; k++) {
      const a = ring[k] as readonly number[];
      const b = ring[k + 1] as readonly number[];
      const x0 = ((a[0] as number) - w) / dLon;
      const y0 = ((a[1] as number) - s) / dLat;
      const x1 = ((b[0] as number) - w) / dLon;
      const y1 = ((b[1] as number) - s) / dLat;
      // An edge east or west of the range marks no cell of it, but its crossings pair others.
      if (Math.max(x0, x1) >= c0 && Math.min(x0, x1) < c1) {
        walk(x0, y0, x1, y1, r0, r1, mark);
      }
      cross(crossings, x0, y0, x1, y1, r0, r1);
    }
  }
  for (const [r, xs] of crossings) {
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(c0, Math.ceil((xs[k] as number) - 0.5));
      const to = Math.min(c1 - 1, Math.floor((xs[k + 1] as number) - 0.5));
      for (let c = from; c <= to; c++) {
        mark(c, r);
      }
    }
  }
}

/** Adds the x where the edge crosses each row centre in [r0, r1), half-open in y. */
function cross(
  crossings: Map<number, number[]>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r0: number,
  r1: number
): void {
  if (y0 === y1) {
    return;
  }
  const lo = Math.max(r0, Math.ceil(Math.min(y0, y1) - 0.5));
  const hi = Math.min(r1 - 1, Math.ceil(Math.max(y0, y1) - 0.5) - 1);
  for (let r = lo; r <= hi; r++) {
    const yc = r + 0.5;
    const x = x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0);
    const list = crossings.get(r);
    if (list) {
      list.push(x);
    } else {
      crossings.set(r, [x]);
    }
  }
}

/** Every cell the segment passes through, rows outside [r0, r1) skipped (Amanatides–Woo). */
function walk(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r0: number,
  r1: number,
  mark: (c: number, r: number) => void
): void {
  if (Math.max(y0, y1) < r0 || Math.min(y0, y1) >= r1) {
    return;
  }
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const tdx = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tdy = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tx = dx > 0 ? (cx + 1 - x0) * tdx : dx < 0 ? (x0 - cx) * tdx : Infinity;
  let ty = dy > 0 ? (cy + 1 - y0) * tdy : dy < 0 ? (y0 - cy) * tdy : Infinity;
  let steps = Math.abs(Math.floor(x1) - cx) + Math.abs(Math.floor(y1) - cy);
  mark(cx, cy);
  while (steps-- > 0) {
    if (tx < ty) {
      cx += sx;
      tx += tdx;
    } else {
      cy += sy;
      ty += tdy;
    }
    mark(cx, cy);
  }
}
