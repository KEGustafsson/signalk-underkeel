import type { Rect, XY } from "../foundation/geo";
import type { Geom, Ring } from "../foundation/geometry";
import { geomBounds, pointInPolygon, pointInRing } from "../foundation/geometry";
import type { RuleFeature } from "../ingest/rule-features";
import { RULE_LAYERS } from "../ingest/rule-features";

/**
 * The index's rule features (`ingest/rule-features.ts`) in a grid of square cells, and
 * `rules.json`, the file the index saves them in. They are few beside the depth features, so
 * a grid keeps a corridor's lookup to the features near it.
 */

/** Grid cell side, Mercator metres. */
const CELL = 2000;

const MAGIC = "underkeel-rules";
/** 2 added the preference objects: an index saved with 1 is rebuilt to hold them. */
export const RULES_VERSION = 2;

export class RuleIndex {
  private readonly grid = new Map<string, number[]>();
  private readonly bounds: Rect[];

  constructor(private readonly all: readonly RuleFeature[]) {
    this.bounds = all.map((f) => geomBounds(f.geom));
    this.bounds.forEach((b, i) => {
      for (const key of keys(b)) {
        const at = this.grid.get(key);
        if (at) {
          at.push(i);
        } else {
          this.grid.set(key, [i]);
        }
      }
    });
  }

  get size(): number {
    return this.all.length;
  }

  features(): readonly RuleFeature[] {
    return this.all;
  }

  /** The features whose bounds meet `r`, each once. */
  near(r: Rect): RuleFeature[] {
    const seen = new Set<number>();
    for (const key of keys(r)) {
      for (const i of this.grid.get(key) ?? []) {
        const b = this.bounds[i] as Rect;
        if (b.maxX >= r.minX && b.minX <= r.maxX && b.maxY >= r.minY && b.minY <= r.maxY) {
          seen.add(i);
        }
      }
    }
    return [...seen].sort((a, b) => a - b).map((i) => this.all[i] as RuleFeature);
  }
}

function* keys(r: Rect): Generator<string> {
  const x0 = Math.floor(r.minX / CELL);
  const x1 = Math.floor(r.maxX / CELL);
  const y0 = Math.floor(r.minY / CELL);
  const y1 = Math.floor(r.maxY / CELL);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      yield `${x},${y}`;
    }
  }
}

function orientation(a: XY, b: XY, c: XY): number {
  return Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/** True when segments a–b and c–d share a point. */
export function segmentsMeet(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  );
}

/**
 * True when a segment of `path` (closed when `closed`) crosses an edge of `ring`. A segment
 * whose box misses the ring's box is passed over before any edge is tested: a restricted area
 * of a thousand vertices meets a corridor at a few of them.
 */
function pathMeets(path: Ring, closed: boolean, ring: Ring, box: Rect): boolean {
  const n = closed ? path.length : path.length - 1;
  for (let i = 0; i < n; i++) {
    const a = path[i] as XY;
    const b = path[(i + 1) % path.length] as XY;
    if (
      Math.max(a[0], b[0]) < box.minX ||
      Math.min(a[0], b[0]) > box.maxX ||
      Math.max(a[1], b[1]) < box.minY ||
      Math.min(a[1], b[1]) > box.maxY
    ) {
      continue;
    }
    for (let k = 0; k < ring.length; k++) {
      if (segmentsMeet(a, b, ring[k] as XY, ring[(k + 1) % ring.length] as XY)) {
        return true;
      }
    }
  }
  return false;
}

/** Whether an edge of `geom` crosses one of `ring`. */
function edgesMeet(geom: Geom, ring: Ring, box: Rect): boolean {
  if (geom.type === "point") {
    return false;
  }
  if (geom.type === "line") {
    return pathMeets(geom.coords, false, ring, box);
  }
  return geom.polygons.some((poly) =>
    [poly.outer, ...poly.holes].some((r) => pathMeets(r, true, ring, box))
  );
}

function ringBox(ring: Ring): Rect {
  const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of ring) {
    r.minX = Math.min(r.minX, x);
    r.minY = Math.min(r.minY, y);
    r.maxX = Math.max(r.maxX, x);
    r.maxY = Math.max(r.maxY, y);
  }
  return r;
}

/** A point of each part of `geom`: a point's own, a line's first, each polygon's first vertex. */
function partPoints(geom: Geom): XY[] {
  if (geom.type === "point") {
    return [geom.p];
  }
  if (geom.type === "line") {
    return geom.coords.slice(0, 1);
  }
  return geom.polygons.flatMap((poly) => poly.outer.slice(0, 1));
}

/**
 * True when `geom` meets the area inside `ring`, a corridor or a box: an edge of one crosses
 * the other's, a part of `geom` lies inside the ring, or the ring inside a polygon of `geom`.
 */
export function meetsRing(geom: Geom, ring: Ring): boolean {
  if (partPoints(geom).some((p) => pointInRing(p, ring))) {
    return true;
  }
  if (edgesMeet(geom, ring, ringBox(ring))) {
    return true;
  }
  const corner = ring[0];
  return (
    geom.type === "polygon" &&
    corner !== undefined &&
    geom.polygons.some((poly) => pointInPolygon(corner, poly))
  );
}

interface RulesFile {
  magic: string;
  version: number;
  count: number;
  features: RuleFeature[];
}

export function serializeRules(index: RuleIndex): string {
  const file: RulesFile = {
    magic: MAGIC,
    version: RULES_VERSION,
    count: index.size,
    features: [...index.features()]
  };
  return JSON.stringify(file);
}

/**
 * `rules.json` read back; a file of a later version, or short of its count, is refused. An
 * earlier version holds the same features but fewer classes: it is read, so an index whose
 * cells are away still loads, and it is rebuilt once they are back (`isCurrentRules`).
 */
export function readRules(text: string): RuleIndex {
  const file = JSON.parse(text) as Partial<RulesFile>;
  const version = file.version;
  if (
    file.magic !== MAGIC ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > RULES_VERSION
  ) {
    throw new Error(`rules.json is not version 1..${RULES_VERSION} of ${MAGIC}`);
  }
  const features = Array.isArray(file.features) ? file.features : [];
  const known = new Set<string>(RULE_LAYERS);
  if (features.length !== file.count || features.some((f) => !known.has(f.objectClass))) {
    throw new Error("rules.json does not hold the features its header counts");
  }
  // A coordinate past any number would never let the grid stop: the file is refused, and rebuilt.
  if (!features.every((f) => finiteGeom(f.geom))) {
    throw new Error("rules.json holds a coordinate that is not a finite number");
  }
  return new RuleIndex(features);
}

const finiteXY = (p: unknown): boolean =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

function finiteGeom(g: Partial<Geom> | undefined): boolean {
  if (g?.type === "point") {
    return finiteXY(g.p);
  }
  if (g?.type === "line") {
    return Array.isArray(g.coords) && g.coords.length > 0 && g.coords.every(finiteXY);
  }
  return (
    g?.type === "polygon" &&
    Array.isArray(g.polygons) &&
    g.polygons.every((poly) => [poly.outer, ...poly.holes].every((r) => r.every(finiteXY)))
  );
}

/** True when `text`, the head of a `rules.json`, is of this version. */
export function isCurrentRules(head: string): boolean {
  return head.startsWith(`{"magic":"${MAGIC}","version":${RULES_VERSION},`);
}
