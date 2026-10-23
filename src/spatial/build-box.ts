import fs from "fs";
import path from "path";
import { writeFileDurable } from "../foundation/durable-file";
import type { Rect } from "../foundation/geo";
import { EARTH_RADIUS, toMercator } from "../foundation/geo";
import { bboxesMeet, encBounds } from "../ingest/enc-bounds";
import { isEncFile } from "../ingest/cell-source";
import type { Bbox } from "../ingest/wfs-fetch";

/**
 * The box an index is built in around the vessel (plan §4.2): only the cells
 * reaching it are read and only its tiles are built; every tile outside it is
 * no coverage, so the look-ahead and route checks there are `unknown` or
 * `unverified`, never clear. The box is saved beside the index with the cell
 * stamps it was chosen from, so a start finds whether the saved index still
 * serves the box.
 */

export const BOX_FILE = "box.json";

/** Cells are read this far beyond the box: past it no feature can set a tile inside. */
export const BOX_MARGIN_KM = 5;

export interface BuildBox {
  bbox: Bbox;
  /** Every source's stamp, sorted, when the cells were chosen. */
  sources: string[];
  /** The leaf zoom it was built at; written with the index, absent in a job. */
  leafZoom?: number;
}

/** `bbox` grown by `km` on every side. */
export function growBbox([w, s, e, n]: Bbox, km: number): Bbox {
  const dLat = ((km * 1000) / EARTH_RADIUS) * (180 / Math.PI);
  const dLon = dLat / Math.cos((Math.min(85, Math.max(Math.abs(s), Math.abs(n))) * Math.PI) / 180);
  return [w - dLon, Math.max(-85, s - dLat), e + dLon, Math.min(85, n + dLat)];
}

/** The box in Web Mercator metres, as the pyramid build's `within`. */
export function boxRect([w, s, e, n]: Bbox): Rect {
  const [minX, minY] = toMercator(w, s);
  const [maxX, maxY] = toMercator(e, n);
  return { minX, minY, maxX, maxY };
}

/**
 * The sources that can reach `bbox`, in their order: every directory (the
 * Traficom WFS cell), and each S-57 cell whose extent meets the box grown by
 * BOX_MARGIN_KM or whose extent could not be read.
 */
export function boxCells(dirs: readonly string[], bbox: Bbox): string[] {
  const reach = growBbox(bbox, BOX_MARGIN_KM);
  return dirs.filter((d) => {
    if (!isEncFile(d)) {
      return true;
    }
    const b = encBounds(d);
    return b === undefined || bboxesMeet(b, reach);
  });
}

export function writeBox(staging: string, box: BuildBox): void {
  writeFileDurable(path.join(staging, BOX_FILE), JSON.stringify({ version: 1, ...box }));
}

/** The box the index in `dir` was built in; undefined for a whole build or an unreadable file. */
export function readBox(dir: string): BuildBox | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, BOX_FILE), "utf8")) as {
      version?: unknown;
      bbox?: unknown;
      sources?: unknown;
      leafZoom?: unknown;
    };
    const { bbox, sources, leafZoom } = json;
    if (
      json.version !== 1 ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every(Number.isFinite) ||
      !Array.isArray(sources) ||
      !sources.every((s) => typeof s === "string")
    ) {
      return undefined;
    }
    const box: BuildBox = { bbox: bbox as Bbox, sources: sources as string[] };
    return typeof leafZoom === "number" ? { ...box, leafZoom } : box;
  } catch {
    return undefined;
  }
}
