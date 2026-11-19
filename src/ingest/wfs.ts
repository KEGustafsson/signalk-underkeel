import fs from "fs";
import path from "path";
import { syncDirectory } from "../foundation/durable-file";
import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS } from "../foundation/geo";
import type { GeoJsonFeatureCollection } from "./s57-geojson";
import type { Bbox, WfsFeature, WfsFetch } from "./wfs-fetch";
import type { Limit } from "./wfs-fetch";
import { fetchLayer, limiter, num, retried, WFS_LIMITS } from "./wfs-fetch";

export type { Bbox, ByteStream, WfsFetch } from "./wfs-fetch";
export { WFS_LIMITS } from "./wfs-fetch";

/**
 * Optional depth source: the Traficom INSPIRE WFS (`DepthArea_A`,
 * `DredgedArea_A`, `Sounding_P`) for a box around the vessel, written as a cell directory
 * in the GeoJSON layer layout the cell reader parses. The data is licensed
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

/** The box reaching `radiusKm` north, south, east and west of `[lon, lat]`. */
export function boxAround([lon, lat]: LonLat, radiusKm: number): Bbox {
  const dLat = ((radiusKm * 1000) / EARTH_RADIUS) * (180 / Math.PI);
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** Metres from `pos` along `bearing` (radians from north) to the edge of `b`; 0 outside it. */
export function edgeAhead([lon, lat]: LonLat, bearing: number, [w, s, e, n]: Bbox): number {
  if (lon < w || lon > e || lat < s || lat > n) {
    return 0;
  }
  const mLat = (EARTH_RADIUS * Math.PI) / 180;
  const mLon = mLat * Math.cos((lat * Math.PI) / 180);
  const dx = Math.sin(bearing);
  const dy = Math.cos(bearing);
  const tx = dx > 0 ? ((e - lon) * mLon) / dx : dx < 0 ? ((w - lon) * mLon) / dx : Infinity;
  const ty = dy > 0 ? ((n - lat) * mLat) / dy : dy < 0 ? ((s - lat) * mLat) / dy : Infinity;
  return Math.min(tx, ty);
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

const ring = ([w, s, e, n]: Bbox): number[][][] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s]
  ]
];

const inside = (p: unknown, [w, s, e, n]: Bbox): boolean => {
  const c = p as number[];
  return (
    (c[0] as number) >= w && (c[0] as number) < e && (c[1] as number) >= s && (c[1] as number) < n
  );
};

/** The features of `l` clipped to each of `parts`: areas cut at each part, soundings in one. */
export interface ClippedLayers {
  depthAreas: unknown[];
  dredgedAreas: unknown[];
  soundings: unknown[];
}

/** Appends `l` clipped to `parts` to `out`; a sounding on a shared edge goes to one part. */
export function clipTo(l: WfsLayers, parts: readonly Bbox[], out: ClippedLayers): void {
  // Appended one by one: a spread of more than ~100 000 features overflows the call stack.
  for (const p of parts) {
    for (const f of areas(l.depthAreas, p)) {
      out.depthAreas.push(f);
    }
    for (const f of areas(l.dredgedAreas, p)) {
      out.dredgedAreas.push(f);
    }
  }
  const points = soundings(l.soundings) as { geometry: { coordinates: unknown } }[];
  for (const f of points) {
    if (parts.length === 1 || parts.some((p) => inside(f.geometry.coordinates, p))) {
      out.soundings.push(f);
    }
  }
}

/**
 * The cell's GeoJSON layers. Coverage is the box, or each of `parts` (a corridor) when given:
 * past them the cell is no coverage. The WFS has no survey quality, so the configured CATZOC
 * is written as an assumed M_QUAL zone over the coverage; with 6 (U) none is written and the
 * cell is unassessed.
 */
export function toCellLayers(
  l: WfsLayers,
  b: Bbox,
  fetchedAt: Date,
  catzoc = 6,
  parts: readonly Bbox[] = [b]
): Record<string, GeoJsonFeatureCollection> {
  const clipped: ClippedLayers = { depthAreas: [], dredgedAreas: [], soundings: [] };
  clipTo(l, parts, clipped);
  return cellLayers(clipped, parts, fetchedAt, catzoc);
}

/** The cell's layers of features already clipped to `parts`, its coverage. */
export function cellLayers(
  clipped: ClippedLayers,
  parts: readonly Bbox[],
  fetchedAt: Date,
  catzoc = 6
): Record<string, GeoJsonFeatureCollection> {
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
    M_COVR: collection(
      parts.map((p, i) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: ring(p) },
        properties: { CATCOV: 1, LNAM: i === 0 ? "WFS-COVR" : `WFS-COVR-${i}` }
      }))
    ),
    M_QUAL: collection(
      catzoc === 6
        ? []
        : parts.map((p, i) => ({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: ring(p) },
            properties: {
              CATZOC: catzoc,
              LNAM: i === 0 ? "WFS-QUAL-ASSUMED" : `WFS-QUAL-ASSUMED-${i}`
            }
          }))
    ),
    DEPARE: collection(clipped.depthAreas),
    DRGARE: collection(clipped.dredgedAreas),
    SOUNDG: collection(clipped.soundings)
  };
}

/**
 * Writes the layers beside `dir` and swaps them in, so a failed write leaves the old cell.
 * The layers are flushed before the swap and the swap after it, so a power cut leaves the
 * old cell, the new one or none, never an empty or torn layer that fails the next start.
 */
export function writeCell(dir: string, layers: Record<string, GeoJsonFeatureCollection>): void {
  const staging = `${dir}.partial`;
  const previous = `${dir}.old`;
  // A cut between the two renames left the only cell aside: put it back before anything goes.
  if (!fs.existsSync(dir) && fs.existsSync(previous)) {
    fs.renameSync(previous, dir);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [name, fc] of Object.entries(layers)) {
    const fd = fs.openSync(path.join(staging, `${name}.geojson`), "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(fc));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  syncDirectory(staging);
  const had = fs.existsSync(dir);
  if (had) {
    fs.renameSync(dir, previous);
  }
  try {
    fs.renameSync(staging, dir);
  } catch (err) {
    if (had) {
      fs.renameSync(previous, dir);
    }
    throw err;
  }
  syncDirectory(path.dirname(dir));
  fs.rmSync(previous, { recursive: true, force: true });
}

export interface WfsDownload {
  fetch: WfsFetch;
  url: string;
  bbox: Bbox;
  /**
   * A corridor's boxes within `bbox`: the cell covers them alone, and they are downloaded in
   * groups (`partGroups`), not the whole of `bbox`.
   */
  parts?: readonly Bbox[];
  /** The cell directory to write, e.g. `<data dir>/wfs/FI1WFS01`. */
  dir: string;
  now: Date;
  /** CATZOC assumed for the whole box; 6 (U) leaves it unassessed. */
  catzoc?: number;
  signal?: AbortSignal;
}

const union = (a: Bbox, b: Bbox): Bbox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3])
];

const degrees2 = (b: Bbox): number => (b[2] - b[0]) * (b[3] - b[1]);

/**
 * `parts` in download groups, in their order: consecutive parts while the group's box keeps
 * within the WFS spans and at most twice their area, so a corridor is a few requests, not one
 * per part, nor its whole box.
 */
export function partGroups(parts: readonly Bbox[]): Bbox[][] {
  const groups: Bbox[][] = [];
  let group: Bbox[] = [];
  let box: Bbox | undefined;
  let area = 0;
  for (const p of parts) {
    const next = box ? union(box, p) : p;
    if (
      group.length > 0 &&
      (bboxProblem(next) !== undefined || degrees2(next) > 2 * (area + degrees2(p)))
    ) {
      groups.push(group);
      group = [];
      area = 0;
      box = p;
    } else {
      box = next;
    }
    group.push(p);
    area += degrees2(p);
  }
  if (group.length > 0) {
    groups.push(group);
  }
  return groups;
}

const boxOf = (group: readonly Bbox[]): Bbox => group.reduce(union);

/** The three layers in `bbox`, side by side; the first failure stops the others. */
async function fetchLayers(d: WfsDownload, bbox: Bbox, limit: Limit): Promise<WfsLayers> {
  const failed = new AbortController();
  const signal = d.signal ? AbortSignal.any([d.signal, failed.signal]) : failed.signal;
  const get = (typeName: string): Promise<WfsFeature[]> =>
    fetchLayer({ fetch: d.fetch, base: d.url, typeName, bbox, limit, signal }).catch(
      (err: unknown) => {
        failed.abort(err);
        throw err;
      }
    );
  const [depthAreas, dredgedAreas, soundings] = await Promise.all([
    get("rajoitettu:DepthArea_A"),
    get("rajoitettu:DredgedArea_A"),
    get("rajoitettu:Sounding_P")
  ]);
  return { depthAreas, dredgedAreas, soundings };
}

/** Downloads the box, or its corridor's parts, and writes the cell; resolves with the counts. */
export async function downloadWfsCell(
  d: WfsDownload
): Promise<{ depthAreas: number; dredgedAreas: number; soundings: number }> {
  const parts = d.parts !== undefined && d.parts.length > 0 ? d.parts : [d.bbox];
  const groups = parts === d.parts ? partGroups(parts) : [parts];
  // A corridor's whole box is not downloaded: its groups keep to the spans.
  for (const g of groups) {
    const problem = bboxProblem(boxOf(g));
    if (problem !== undefined) {
      throw new Error(problem);
    }
  }
  const limit = limiter(WFS_LIMITS.concurrency);
  const clipped: ClippedLayers = { depthAreas: [], dredgedAreas: [], soundings: [] };
  const counts = { depthAreas: 0, dredgedAreas: 0, soundings: 0 };
  for (const g of groups) {
    // One group of many is tried again: a corridor is a few minutes of downloads.
    const get = () => fetchLayers(d, boxOf(g), limit);
    const l = groups.length > 1 ? await retried(get, d.signal) : await get();
    clipTo(l, g, clipped);
    counts.depthAreas += l.depthAreas.length;
    counts.dredgedAreas += l.dredgedAreas.length;
    counts.soundings += l.soundings.length;
  }
  writeCell(d.dir, cellLayers(clipped, parts, d.now, d.catzoc));
  return counts;
}
