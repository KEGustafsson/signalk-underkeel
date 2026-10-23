import fs from "fs";
import path from "path";
import type { CellInfo } from "./cells";
import { compilationSigma, usageBandFromName } from "./cells";
import type { ChartFeature } from "./features";
import type { GeoJsonFeatureCollection } from "./s57-geojson";
import { parseLayer, POSITION_LAYER, S57_LAYERS } from "./s57-geojson";
import { WFS_SOURCE } from "./wfs";

/**
 * Reads one cell from its GeoJSON layers: a directory holding `<LAYER>.geojson` files
 * plus `DSID.geojson` (the dataset identification record) and the datum
 * areas `M_SDAT.geojson` / `M_VDAT.geojson` for provenance, and
 * `QUAPOS.geojson`, the spatial records whose position is not surveyed.
 * The gdal3.js reader yields the same layers from a `.000` cell; the plugin
 * keeps the Traficom WFS cell in this layout.
 */

export interface ReadCell {
  info: CellInfo;
  features: ChartFeature[];
}

function readCollection(file: string): GeoJsonFeatureCollection | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as GeoJsonFeatureCollection;
  if (json.type !== "FeatureCollection" || !Array.isArray(json.features)) {
    throw new Error(`${file} is not a GeoJSON FeatureCollection`);
  }
  return json;
}

function numeric(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

const positive = (n: number | undefined): number | undefined =>
  n !== undefined && n > 0 ? n : undefined;

/** Cell provenance from GDAL's DSID layer attributes. */
export function cellInfoFromDsid(
  props: Record<string, unknown>,
  fallbackName: string
): Omit<CellInfo, "band"> & { band?: number } {
  const dsnm = typeof props.DSID_DSNM === "string" ? props.DSID_DSNM : fallbackName;
  const name = dsnm.replace(/\.\d{3}$/, "");
  return {
    name,
    edition: numeric(props.DSID_EDTN) ?? 0,
    update: numeric(props.DSID_UPDN) ?? 0,
    issueDate: typeof props.DSID_ISDT === "string" ? props.DSID_ISDT : undefined,
    band: usageBandFromName(name),
    verticalDatum: numeric(props.DSPM_VDAT),
    soundingDatum: numeric(props.DSPM_SDAT),
    source: typeof props.UK_SOURCE === "string" ? props.UK_SOURCE : undefined,
    compilationScale: positive(numeric(props.DSPM_CSCL))
  };
}

/** A cell's layers by S-57 name: from exported files, or read from the .000 itself. */
export type CellLayers = (layer: string) => GeoJsonFeatureCollection | undefined;

/** The layers of an exported cell directory, one `<LAYER>.geojson` each. */
export function directoryLayers(dir: string): CellLayers {
  return (layer) => readCollection(path.join(dir, `${layer}.geojson`));
}

/** VERDAT codes of the areas in `areas` that are not `datum`. */
function otherDatums(
  collection: GeoJsonFeatureCollection | undefined,
  datum: number | undefined
): number[] {
  const areas = collection?.features ?? [];
  return areas
    .map((f) => numeric(f.properties?.VERDAT))
    .filter((v): v is number => v !== undefined && v !== datum);
}

/**
 * Provenance of an exported cell from its DSID and datum areas, without
 * reading its depth layers.
 */
export function readCellInfo(dir: string): ReturnType<typeof cellInfoFromDsid> {
  return cellInfoFrom(directoryLayers(dir), path.basename(dir));
}

/** Provenance from a cell's DSID, datum areas and positional quality layer. */
export function cellInfoFrom(
  layers: CellLayers,
  fallbackName: string
): ReturnType<typeof cellInfoFromDsid> {
  const dsid = layers("DSID");
  const dsidInfo = cellInfoFromDsid(dsid?.features[0]?.properties ?? {}, fallbackName);
  const positioned = layers(POSITION_LAYER) !== undefined;
  const info = positioned ? { ...dsidInfo, positionQuality: true } : dsidInfo;
  const areas = new Set([
    ...otherDatums(layers("M_SDAT"), info.soundingDatum),
    ...otherDatums(layers("M_VDAT"), info.verticalDatum)
  ]);
  return areas.size > 0 ? { ...info, datumAreas: [...areas].sort((a, b) => a - b) } : info;
}

/** A missing directory is an error, as is one without M_COVR coverage. */
export function readCellDirectory(dir: string, cellRef: number, bandOverride?: number): ReadCell {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`cell directory ${dir} does not exist`);
  }
  return readCellLayers(directoryLayers(dir), path.basename(dir), cellRef, bandOverride, dir);
}

/**
 * A cell from its layers, wherever they come from. One without M_COVR
 * coverage is an error: it would enter the catalogue while contributing no
 * data.
 */
export function readCellLayers(
  layers: CellLayers,
  fallbackName: string,
  cellRef: number,
  bandOverride?: number,
  where = fallbackName
): ReadCell {
  const partial = cellInfoFrom(layers, fallbackName);
  const band = bandOverride ?? partial.band;
  if (band === undefined) {
    throw new Error(`cell ${partial.name}: usage band unknown; set it explicitly`);
  }
  const info: CellInfo = { ...partial, band };
  const advisory = info.source === WFS_SOURCE ? true : undefined;
  // Without the positional quality an approximate shoreline cannot be told
  // from a surveyed one, so the shoreline keeps the survey's σ.
  const topoSigma =
    info.positionQuality && info.compilationScale !== undefined
      ? compilationSigma(info.compilationScale)
      : undefined;
  const features: ChartFeature[] = [];
  for (const layer of S57_LAYERS) {
    const collection = layers(layer);
    if (collection) {
      const ctx = { cellRef, band, advisory, topoSigma };
      const scale = info.compilationScale;
      features.push(
        ...parseLayer(layer, collection, scale === undefined ? ctx : { ...ctx, scale })
      );
    }
  }
  if (!features.some((f) => f.role === "coverage")) {
    throw new Error(`cell ${info.name}: no M_COVR coverage in ${where}`);
  }
  return { info, features };
}
