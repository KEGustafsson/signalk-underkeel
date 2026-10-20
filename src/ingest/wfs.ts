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
  maxFeatures: 50_000,
  /** A layer that takes more pages than this is refused, so a server that ignores startIndex stops. */
  maxPages: 100,
  /** A page body larger than this fails the download: the 10 km box is one 22 MB page. */
  maxPageBytes: 64 * 2 ** 20,
  /**
   * A response or body that sends nothing for this long fails the download, so a stalled
   * server ends it while a slow link that keeps sending is read to the end.
   */
  idleTimeoutMs: 30_000
} as const;

/** What a page body is read through; a fetch Response's `body`. */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
}

/** A response without `body` is read with text() and checked against the cap afterwards. */
export type WfsFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; body?: ByteStream | null; text(): Promise<string> }>;

/** [west, south, east, north], degrees. */
export type Bbox = [number, number, number, number];

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
  // A server may return fewer features per page than asked, so a short page is not the end:
  // read to numberMatched when the server reports it, else to an empty page.
  for (let pages = 1; ; pages++) {
    const page = (await fetchPage(
      fetch,
      pageUrl(base, typeName, b, out.length),
      typeName,
      signal
    )) as {
      type?: unknown;
      features?: unknown;
      numberMatched?: unknown;
    };
    if (page.type !== "FeatureCollection" || !Array.isArray(page.features)) {
      throw new Error(`${typeName}: not a GeoJSON FeatureCollection`);
    }
    if (out.length + page.features.length > WFS_LIMITS.maxFeatures) {
      throw new Error(
        `${typeName}: more than ${WFS_LIMITS.maxFeatures} features; use a smaller box`
      );
    }
    // A spread of a page of more than ~100 000 features would overflow the call stack.
    for (const f of page.features as WfsFeature[]) {
      out.push(f);
    }
    const matched = num(page.numberMatched);
    if (page.features.length === 0 || (matched !== undefined && out.length >= matched)) {
      return out;
    }
    if (pages >= WFS_LIMITS.maxPages) {
      throw new Error(`${typeName}: more than ${WFS_LIMITS.maxPages} pages`);
    }
  }
}

async function fetchPage(
  fetch: WfsFetch,
  url: string,
  typeName: string,
  signal?: AbortSignal
): Promise<unknown> {
  const idle = new AbortController();
  let stalled: Error | undefined;
  let timer: NodeJS.Timeout | undefined;
  const alive = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = new Error(`${typeName}: no data for ${WFS_LIMITS.idleTimeoutMs / 1000} s`);
      idle.abort(stalled);
    }, WFS_LIMITS.idleTimeoutMs);
  };
  const ended = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  alive();
  try {
    const res = await unlessAborted(fetch(url, { signal: ended }), ended);
    if (!res.ok) {
      throw new Error(`${typeName}: HTTP ${res.status}`);
    }
    const text = res.body
      ? await readBody(res.body, typeName, ended, alive)
      : await unlessAborted(res.text(), ended);
    if (Buffer.byteLength(text) > WFS_LIMITS.maxPageBytes) {
      throw tooLarge(typeName);
    }
    return JSON.parse(text);
  } catch (err) {
    if (stalled && !signal?.aborted) {
      throw stalled;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const tooLarge = (typeName: string): Error =>
  new Error(
    `${typeName}: page larger than ${WFS_LIMITS.maxPageBytes / 2 ** 20} MB; use a smaller box`
  );

/** The body as text, read chunk by chunk; `alive` is called for every chunk. */
async function readBody(
  body: ByteStream,
  typeName: string,
  signal: AbortSignal,
  alive: () => void
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await unlessAborted(reader.read(), signal);
      if (done || !value) {
        return Buffer.concat(chunks).toString("utf8");
      }
      size += value.byteLength;
      if (size > WFS_LIMITS.maxPageBytes) {
        throw tooLarge(typeName);
      }
      chunks.push(value);
      alive();
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** `p`, or a rejection with the signal's reason once it aborts: a fake or hung read may ignore it. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason as Error);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(err as Error);
      }
    );
  });
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
