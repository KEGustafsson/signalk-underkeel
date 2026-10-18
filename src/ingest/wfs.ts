import fs from "fs";
import path from "path";
import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS } from "../foundation/geo";
import type { GeoJsonFeatureCollection } from "./s57-geojson";

/**
 * Optional depth source: the Traficom INSPIRE WFS (`DepthArea_A`,
 * `DredgedArea_A`, `Sounding_P`) for a box around the vessel, written as a cell directory
 * in the layout `scripts/enc-to-geojson.sh` produces. The data is licensed
 * for non-navigational use only and has no land, rocks, wrecks or survey
 * quality, so the cell is marked with `UK_SOURCE` and the index treats it
 * as advisory: water without a depth area is land, and nothing it covers
 * is reported as clear (plan §4.2).
 */

export const WFS_SOURCE = "traficom-wfs";
/** Band 1 (overview), so every ENC cell takes precedence where both cover. */
export const WFS_CELL_NAME = "FI1WFS01";
export const DEFAULT_WFS_URL = "https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs";
export const WFS_NOTICE =
  "depths from the Traficom WFS: not for navigational purposes; no rocks, wrecks or survey quality";

export const WFS_LIMITS = {
  /** Half-width of the box around the vessel, km. */
  minRadiusKm: 2,
  maxRadiusKm: 25,
  /** Box size in degrees, which a 25 km radius stays inside up to 70° latitude. */
  maxLatSpan: 0.5,
  maxLonSpan: 1.5,
  pageSize: 5000,
  /** A box that returns more features than this is refused. */
  maxFeatures: 50_000
} as const;

export type WfsFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** [west, south, east, north], degrees. */
export type Bbox = [number, number, number, number];

/** The box reaching `radiusKm` north, south, east and west of `[lon, lat]`. */
export function boxAround([lon, lat]: LonLat, radiusKm: number): Bbox {
  const dLat = ((radiusKm * 1000) / EARTH_RADIUS) * (180 / Math.PI);
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** Why `b` cannot be downloaded, or undefined when it can. */
export function bboxProblem(b: Bbox): string | undefined {
  const [w, s, e, n] = b;
  if (![w, s, e, n].every(Number.isFinite) || w < -180 || e > 180 || s < -85 || n > 85) {
    return "WFS box must be finite [west, south, east, north] within ±180 / ±85";
  }
  if (w >= e || s >= n) {
    return "WFS box must have west < east and south < north";
  }
  if (n - s > WFS_LIMITS.maxLatSpan || e - w > WFS_LIMITS.maxLonSpan) {
    return `WFS box must be at most ${WFS_LIMITS.maxLatSpan}° north–south and ${WFS_LIMITS.maxLonSpan}° east–west`;
  }
  return undefined;
}

interface WfsFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

function pageUrl(base: string, typeName: string, b: Bbox, start: number): string {
  const [w, s, e, n] = b;
  const q = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    // WFS 2.0 with an EPSG URN reads the box as latitude, longitude.
    bbox: `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`,
    srsName: "EPSG:4326",
    outputFormat: "application/json",
    count: String(WFS_LIMITS.pageSize),
    startIndex: String(start)
  });
  return `${base}?${q.toString()}`;
}

/** Every feature of one layer in the box, page by page. */
async function fetchLayer(
  fetch: WfsFetch,
  base: string,
  typeName: string,
  b: Bbox,
  signal?: AbortSignal
): Promise<WfsFeature[]> {
  const out: WfsFeature[] = [];
  for (;;) {
    const res = await fetch(pageUrl(base, typeName, b, out.length), { signal });
    if (!res.ok) {
      throw new Error(`${typeName}: HTTP ${res.status}`);
    }
    const page = JSON.parse(await res.text()) as { type?: unknown; features?: unknown };
    if (page.type !== "FeatureCollection" || !Array.isArray(page.features)) {
      throw new Error(`${typeName}: not a GeoJSON FeatureCollection`);
    }
    out.push(...(page.features as WfsFeature[]));
    if (out.length > WFS_LIMITS.maxFeatures) {
      throw new Error(
        `${typeName}: more than ${WFS_LIMITS.maxFeatures} features; use a smaller box`
      );
    }
    if (page.features.length < WFS_LIMITS.pageSize) {
      return out;
    }
  }
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function collection(features: unknown[]): GeoJsonFeatureCollection {
  return { type: "FeatureCollection", features } as GeoJsonFeatureCollection;
}

type Ring = number[][];

/**
 * Sutherland–Hodgman clip of one ring to the box. The box is convex, so the
 * result covers exactly the part of the ring's area inside it; edges it adds
 * run along the box border, where the cell's coverage ends anyway.
 */
export function clipRing(ring: Ring, [w, s, e, n]: Bbox): Ring {
  const inside = [
    (p: number[]) => (p[0] as number) >= w,
    (p: number[]) => (p[0] as number) <= e,
    (p: number[]) => (p[1] as number) >= s,
    (p: number[]) => (p[1] as number) <= n
  ];
  const cut = [
    (a: number[], b: number[]) => at(a, b, 0, w),
    (a: number[], b: number[]) => at(a, b, 0, e),
    (a: number[], b: number[]) => at(a, b, 1, s),
    (a: number[], b: number[]) => at(a, b, 1, n)
  ];
  let out = ring.slice(0, ring.length > 1 && same(ring[0], ring[ring.length - 1]) ? -1 : undefined);
  for (let k = 0; k < 4 && out.length > 0; k++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i] as number[];
      const prev = input[(i + input.length - 1) % input.length] as number[];
      const inCur = (inside[k] as (p: number[]) => boolean)(cur);
      const inPrev = (inside[k] as (p: number[]) => boolean)(prev);
      if (inCur !== inPrev) {
        out.push((cut[k] as (a: number[], b: number[]) => number[])(prev, cur));
      }
      if (inCur) {
        out.push([cur[0] as number, cur[1] as number]);
      }
    }
  }
  return out.length >= 3 ? [...out, out[0] as number[]] : [];
}

function same(a: number[] | undefined, b: number[] | undefined): boolean {
  return a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];
}

/** The point of segment a→b where coordinate `axis` equals `v`. */
function at(a: number[], b: number[], axis: 0 | 1, v: number): number[] {
  const t = (v - (a[axis] as number)) / ((b[axis] as number) - (a[axis] as number));
  const p = [0, 1].map((i) => (a[i] as number) + t * ((b[i] as number) - (a[i] as number)));
  p[axis] = v;
  return p;
}

/** A Polygon or MultiPolygon clipped to the box; null when nothing is left inside. */
function clipGeometry(g: { type: string; coordinates: unknown }, b: Bbox): unknown {
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Ring[][];
  const out = polys
    .map((rings) => rings.map((r) => clipRing(r, b)))
    .filter((rings) => (rings[0]?.length ?? 0) > 0)
    .map((rings) => rings.filter((r) => r.length > 0));
  return out.length === 0 ? null : { type: "MultiPolygon", coordinates: out };
}

function areas(features: WfsFeature[], b: Bbox): unknown[] {
  return features
    .filter((f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon")
    .map((f) => ({
      type: "Feature",
      geometry: clipGeometry(f.geometry as { type: string; coordinates: unknown }, b),
      properties: {
        DRVAL1: num(f.properties?.DRVAL1),
        DRVAL2: num(f.properties?.DRVAL2),
        LNAM: f.properties?.IDENTIFIER
      }
    }))
    .filter((f) => f.geometry !== null);
}

function soundings(features: WfsFeature[]): unknown[] {
  return features
    .filter((f) => f.geometry?.type === "Point" && num(f.properties?.DEPTH) !== undefined)
    .map((f) => ({
      type: "Feature",
      geometry: f.geometry,
      properties: { DEPTH: num(f.properties?.DEPTH), LNAM: f.properties?.IDENTIFIER }
    }));
}

export interface WfsLayers {
  depthAreas: WfsFeature[];
  dredgedAreas: WfsFeature[];
  soundings: WfsFeature[];
}

/**
 * The cell's GeoJSON layers. Coverage is the box. The WFS has no survey
 * quality, so the configured CATZOC is written as one assumed M_QUAL zone;
 * with 6 (U) none is written and the cell is unassessed.
 */
export function toCellLayers(
  l: WfsLayers,
  b: Bbox,
  fetchedAt: Date,
  catzoc = 6
): Record<string, GeoJsonFeatureCollection> {
  const [w, s, e, n] = b;
  const box = [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s]
    ]
  ];
  return {
    DSID: collection([
      {
        type: "Feature",
        geometry: null,
        properties: {
          DSID_DSNM: `${WFS_CELL_NAME}.000`,
          DSID_EDTN: "1",
          DSID_UPDN: "0",
          DSID_ISDT: fetchedAt.toISOString().slice(0, 10).replace(/-/g, ""),
          UK_SOURCE: WFS_SOURCE
        }
      }
    ]),
    M_COVR: collection([
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: box },
        properties: { CATCOV: 1, LNAM: "WFS-COVR" }
      }
    ]),
    M_QUAL: collection(
      catzoc === 6
        ? []
        : [
            {
              type: "Feature",
              geometry: { type: "Polygon", coordinates: box },
              properties: { CATZOC: catzoc, LNAM: "WFS-QUAL-ASSUMED" }
            }
          ]
    ),
    DEPARE: collection(areas(l.depthAreas, b)),
    DRGARE: collection(areas(l.dredgedAreas, b)),
    SOUNDG: collection(soundings(l.soundings))
  };
}

/** Writes the layers beside `dir` and swaps them in, so a failed write leaves the old cell. */
export function writeCell(dir: string, layers: Record<string, GeoJsonFeatureCollection>): void {
  const staging = `${dir}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [name, fc] of Object.entries(layers)) {
    fs.writeFileSync(path.join(staging, `${name}.geojson`), JSON.stringify(fc));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
}

export interface WfsDownload {
  fetch: WfsFetch;
  url: string;
  bbox: Bbox;
  /** The cell directory to write, e.g. `<data dir>/wfs/FI1WFS01`. */
  dir: string;
  now: Date;
  /** CATZOC assumed for the whole box; 6 (U) leaves it unassessed. */
  catzoc?: number;
  signal?: AbortSignal;
}

/** Downloads the box and writes the cell; resolves with the feature counts. */
export async function downloadWfsCell(
  d: WfsDownload
): Promise<{ depthAreas: number; dredgedAreas: number; soundings: number }> {
  const problem = bboxProblem(d.bbox);
  if (problem) {
    throw new Error(problem);
  }
  const get = (typeName: string) => fetchLayer(d.fetch, d.url, typeName, d.bbox, d.signal);
  const l: WfsLayers = {
    depthAreas: await get("rajoitettu:DepthArea_A"),
    dredgedAreas: await get("rajoitettu:DredgedArea_A"),
    soundings: await get("rajoitettu:Sounding_P")
  };
  writeCell(d.dir, toCellLayers(l, d.bbox, d.now, d.catzoc));
  return {
    depthAreas: l.depthAreas.length,
    dredgedAreas: l.dredgedAreas.length,
    soundings: l.soundings.length
  };
}
