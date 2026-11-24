import type { Bbox, WfsFeature } from "./wfs-fetch";
import { fetchLayer, limiter, num, readableLine, retried } from "./wfs-fetch";
import type { WfsDownload } from "./wfs";
import { referenceOf } from "./fairway-gaps";

/**
 * What the cell takes from the Finnish Transport Infrastructure Agency's open WFS (CC BY 4.0)
 * besides the Traficom depths: navigation lines, a planner's preference, and the fairway areas
 * swept to a depth.
 */

const FTIA_LINES = "vesivaylatiedot:navigointilinjat_uusi";
/** The FTIA's fairway areas, each with the depth it is swept to (`haraussyvyys`). */
const FTIA_AREAS = "vesivaylatiedot:vaylaalueet_uusi";

/**
 * A navigation line as the cell keeps it: its geometry, the draft it is laid out for, the depth
 * the authority keeps it clear to (`haraussyvyys`, the safe clearance depth) and the reference
 * level both are from (`vertaustaso`, a mean water epoch such as MW2020, or N2000).
 */
function navigationLine(f: WfsFeature): unknown {
  return {
    type: "Feature",
    geometry: f.geometry,
    properties: {
      mitoitussyvays: num(f.properties?.mitoitussyvays),
      haraussyvyys: num(f.properties?.haraussyvyys),
      vertaustaso: referenceOf(f)
    }
  };
}

/**
 * `get`, tried again when it fails for a download that asks for it (`WfsDownload.retry`, a
 * planning box): without its swept areas a fairway reads at its charted depth and a plan that
 * needs it finds no way, with nothing to say a layer was dropped.
 */
const again = <T>(d: WfsDownload, get: () => Promise<T>): Promise<T> =>
  d.retry ? retried(get, d.signal) : get();

/**
 * The navigation lines meeting `bbox`, or none when the FTIA's WFS fails: they are a planner's
 * preference, never a depth, so a cell is written without them rather than not at all.
 */
export async function fetchLines(d: WfsDownload, bbox: Bbox): Promise<unknown[] | undefined> {
  if (d.linesUrl === undefined) {
    return [];
  }
  const { linesUrl } = d;
  const get = (): Promise<WfsFeature[]> =>
    fetchLayer({
      fetch: d.fetch,
      base: linesUrl,
      typeName: FTIA_LINES,
      bbox,
      limit: limiter(1),
      sortBy: "navigointilinjaid",
      ...(d.signal && { signal: d.signal })
    });
  try {
    const features = await again(d, get);
    // A malformed line would fail the cell's whole index build: lines are a preference, never a
    // depth, so one that cannot be read is left out.
    return features.filter(readableLine).map(navigationLine);
  } catch (err) {
    if (d.signal?.aborted) {
      throw err;
    }
    return undefined;
  }
}

const isPosition = (p: unknown): boolean =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

const isRing = (r: unknown): boolean => Array.isArray(r) && r.length >= 4 && r.every(isPosition);

const isPolygon = (rings: unknown): boolean =>
  Array.isArray(rings) && rings.length > 0 && rings.every(isRing);

/**
 * Whether `g` is a Polygon or MultiPolygon whose rings each hold four or more finite positions.
 * A swept area is optional, so a malformed one is left out rather than fail the clip, the fairway
 * gaps or the cell's index build; without it the depth area stands alone, which is never deeper.
 */
function readableArea(g: WfsFeature["geometry"]): boolean {
  if (g?.type === "Polygon") {
    return isPolygon(g.coordinates);
  }
  const c = g?.type === "MultiPolygon" ? g.coordinates : undefined;
  return Array.isArray(c) && c.length > 0 && c.every(isPolygon);
}

/**
 * A fairway area swept to a depth, as a dredged area of the cell at that depth. The Traficom
 * WFS charts a fairway as part of the depth area around it (one 0–3 m area over a channel
 * swept to 2.7 m): the area gives way to it (`spatial/pyramid-build.ts`), as an ENC's depth
 * areas and dredged areas never overlap. Soundings and rocks inside it still count.
 */
function sweptArea(f: WfsFeature): WfsFeature | undefined {
  const depth = num(f.properties?.haraussyvyys);
  if (depth === undefined || depth <= 0 || !readableArea(f.geometry)) {
    return undefined;
  }
  return {
    ...f,
    properties: {
      DRVAL1: depth,
      IDENTIFIER: `FTIA-VA-${String(f.properties?.id ?? "")}`,
      // The gaps compare it with the lines' (`fairway-gaps.ts`); the cell's DRGARE drops it.
      vertaustaso: referenceOf(f)
    }
  };
}

/**
 * The FTIA's fairway areas swept to a depth meeting `bbox`, or none when its WFS fails: the
 * depth areas then stand alone, which is never deeper.
 */
export async function fetchSweptAreas(d: WfsDownload, bbox: Bbox): Promise<WfsFeature[]> {
  if (d.linesUrl === undefined) {
    return [];
  }
  const { linesUrl } = d;
  const get = (): Promise<WfsFeature[]> =>
    fetchLayer({
      fetch: d.fetch,
      base: linesUrl,
      typeName: FTIA_AREAS,
      bbox,
      limit: limiter(1),
      sortBy: "id",
      ...(d.signal && { signal: d.signal })
    });
  try {
    const features = await again(d, get);
    return features.map(sweptArea).filter((f): f is WfsFeature => f !== undefined);
  } catch (err) {
    if (d.signal?.aborted) {
      throw err;
    }
    return [];
  }
}

/**
 * The FTIA's navigation lines and swept areas of the download's box, read from now on; `stop`
 * ends the reads when the depths fail, whose error is then the download's.
 */
export function fairwayLayers(d: WfsDownload): {
  read: Promise<[unknown[] | undefined, WfsFeature[]]>;
  stop: (reason: unknown) => void;
} {
  const failed = new AbortController();
  const signal = d.signal ? AbortSignal.any([d.signal, failed.signal]) : failed.signal;
  const own = { ...d, signal };
  const read = Promise.all([fetchLines(own, d.bbox), fetchSweptAreas(own, d.bbox)]);
  // Awaited after the depths: a rejection before that, or after `stop`, is not left unhandled.
  read.catch(() => undefined);
  return { read, stop: (reason) => failed.abort(reason) };
}
