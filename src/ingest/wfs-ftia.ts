import type { Bbox, WfsFeature } from "./wfs-fetch";
import { fetchLayer, limiter, num, readableLine } from "./wfs-fetch";
import type { WfsDownload } from "./wfs";

/**
 * What the cell takes from the Finnish Transport Infrastructure Agency's open WFS (CC BY 4.0)
 * besides the Traficom depths: navigation lines, a planner's preference, and the fairway areas
 * swept to a depth.
 */

const FTIA_LINES = "vesivaylatiedot:navigointilinjat_uusi";
/** The FTIA's fairway areas, each with the depth it is swept to (`haraussyvyys`). */
const FTIA_AREAS = "vesivaylatiedot:vaylaalueet_uusi";

/** A navigation line as the cell keeps it: its geometry and the draft it is laid out for. */
function navigationLine(f: WfsFeature): unknown {
  return {
    type: "Feature",
    geometry: f.geometry,
    properties: { mitoitussyvays: num(f.properties?.mitoitussyvays) }
  };
}

/**
 * The navigation lines meeting `bbox`, or none when the FTIA's WFS fails: they are a planner's
 * preference, never a depth, so a cell is written without them rather than not at all.
 */
export async function fetchLines(d: WfsDownload, bbox: Bbox): Promise<unknown[] | undefined> {
  if (d.linesUrl === undefined) {
    return [];
  }
  try {
    const features = await fetchLayer({
      fetch: d.fetch,
      base: d.linesUrl,
      typeName: FTIA_LINES,
      bbox,
      limit: limiter(1),
      sortBy: "navigointilinjaid",
      ...(d.signal && { signal: d.signal })
    });
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

/**
 * A fairway area swept to a depth, as a dredged area of the cell at that depth. The Traficom
 * WFS charts a fairway as part of the depth area around it (one 0–3 m area over a channel
 * swept to 2.7 m): the area gives way to it (`spatial/pyramid-build.ts`), as an ENC's depth
 * areas and dredged areas never overlap. Soundings and rocks inside it still count.
 */
function sweptArea(f: WfsFeature): WfsFeature | undefined {
  const depth = num(f.properties?.haraussyvyys);
  const type = f.geometry?.type;
  if (depth === undefined || depth <= 0 || (type !== "Polygon" && type !== "MultiPolygon")) {
    return undefined;
  }
  return {
    ...f,
    properties: { DRVAL1: depth, IDENTIFIER: `FTIA-VA-${String(f.properties?.id ?? "")}` }
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
  try {
    const features = await fetchLayer({
      fetch: d.fetch,
      base: d.linesUrl,
      typeName: FTIA_AREAS,
      bbox,
      limit: limiter(1),
      sortBy: "id",
      ...(d.signal && { signal: d.signal })
    });
    return features.map(sweptArea).filter((f): f is WfsFeature => f !== undefined);
  } catch (err) {
    if (d.signal?.aborted) {
      throw err;
    }
    return [];
  }
}
