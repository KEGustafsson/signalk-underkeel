import fs from "fs";
import path from "path";
import type { CellInfo } from "./cells";
import { usageBandFromName } from "./cells";
import type { ChartFeature } from "./features";
import type { GeoJsonFeatureCollection } from "./s57-geojson";
import { parseLayer, S57_LAYERS } from "./s57-geojson";

/**
 * Reads one exported ENC cell: a directory holding `<LAYER>.geojson` files
 * plus `DSID.geojson` (the dataset identification record) for provenance.
 * `scripts/enc-to-geojson.sh` produces this layout from a `.000` file.
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
    soundingDatum: numeric(props.DSPM_SDAT)
  };
}

/**
 * A missing directory, or one without M_COVR coverage, is an error: such a
 * cell would enter the catalogue while contributing no data.
 */
export function readCellDirectory(dir: string, cellRef: number, bandOverride?: number): ReadCell {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`cell directory ${dir} does not exist`);
  }
  const fallbackName = path.basename(dir);
  const dsid = readCollection(path.join(dir, "DSID.geojson"));
  const partial = cellInfoFromDsid(dsid?.features[0]?.properties ?? {}, fallbackName);
  const band = bandOverride ?? partial.band;
  if (band === undefined) {
    throw new Error(`cell ${partial.name}: usage band unknown; set it explicitly`);
  }
  const info: CellInfo = { ...partial, band };
  const features: ChartFeature[] = [];
  for (const layer of S57_LAYERS) {
    const collection = readCollection(path.join(dir, `${layer}.geojson`));
    if (collection) {
      features.push(...parseLayer(layer, collection, { cellRef, band }));
    }
  }
  if (!features.some((f) => f.role === "coverage")) {
    throw new Error(`cell ${info.name}: no M_COVR coverage in ${dir}`);
  }
  return { info, features };
}
