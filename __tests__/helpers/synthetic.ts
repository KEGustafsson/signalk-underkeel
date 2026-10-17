import type { LonLat } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import type { Geom } from "../../src/foundation/geometry";
import type {
  Catzoc,
  ChartFeature,
  CoverageFeature,
  DepthFeature,
  QualityFeature,
  SweptFeature
} from "../../src/ingest/features";

/** Axis-aligned lon/lat box [west, south, east, north]. */
export type Box = readonly [number, number, number, number];

export function boxGeom([w, s, e, n]: Box): Geom {
  const outer = [toMercator(w, s), toMercator(e, s), toMercator(e, n), toMercator(w, n)];
  return { type: "polygon", polygons: [{ outer, holes: [] }] };
}

export function boxRing([w, s, e, n]: Box): LonLat[] {
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n]
  ];
}

interface Common {
  cellRef?: number;
  band?: number;
}

function base(c: Common) {
  return { cellRef: c.cellRef ?? 0, band: c.band ?? 5 };
}

export function coverage(box: Box, c: Common = {}): CoverageFeature {
  return { role: "coverage", objectClass: "M_COVR", geom: boxGeom(box), ...base(c) };
}

export function quality(box: Box, catzoc: Catzoc, c: Common = {}): QualityFeature {
  return { role: "quality", objectClass: "M_QUAL", geom: boxGeom(box), catzoc, ...base(c) };
}

export function area(
  box: Box,
  depth: number,
  c: Common & { dredged?: boolean } = {}
): DepthFeature {
  return {
    role: "depth",
    objectClass: c.dredged ? "DRGARE" : "DEPARE",
    geom: boxGeom(box),
    depth,
    hazard: false,
    dredged: c.dredged ?? false,
    ...base(c)
  };
}

export function land(box: Box, c: Common = {}): DepthFeature {
  return { ...area(box, -Infinity, c), objectClass: "LNDARE" };
}

export function swept(box: Box, depth: number, c: Common = {}): SweptFeature {
  return { role: "swept", objectClass: "SWPARE", geom: boxGeom(box), depth, ...base(c) };
}

export function point(
  lon: number,
  lat: number,
  depth: number,
  c: Common & { objectClass?: string; lnam?: string } = {}
): DepthFeature {
  return {
    role: "depth",
    objectClass: c.objectClass ?? "UWTROC",
    geom: { type: "point", p: toMercator(lon, lat) },
    depth,
    hazard: true,
    dredged: false,
    lnam: c.lnam,
    ...base(c)
  };
}

/** A fully covered, CATZOC A1 test area with a uniform depth. */
export function basin(box: Box, depth: number, c: Common = {}): ChartFeature[] {
  return [coverage(box, c), quality(box, 1, c), area(box, depth, c)];
}
