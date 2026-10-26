/**
 * Cell provenance (`cells.json`). Every index node and every result points
 * back at an entry here, so a check can say which chart edition it used.
 */

export interface CellInfo {
  /** ENC cell name, e.g. "FI5ABCDE". */
  name: string;
  edition: number;
  update: number;
  /** Issue date as printed in the DSID record (YYYYMMDD), when known. */
  issueDate?: string;
  /** Usage band 1–6. */
  band: number;
  /** S-57 VERDAT code of the vertical datum, when known. */
  verticalDatum?: number;
  /** S-57 VERDAT code of the sounding datum, when known. */
  soundingDatum?: number;
  /**
   * VERDAT codes of M_SDAT / M_VDAT areas that differ from the DSID datum.
   * Such a cell's depths are not all on one datum, so its datum is unknown.
   */
  datumAreas?: number[];
  /** Set for cells built from a non-ENC source, e.g. "traficom-wfs". */
  source?: string;
  /**
   * Hash of the names, sizes and modification times of an S-57 cell's `.000` and update
   * files, for a cell read from them: a saved index whose entry matches needs no new read.
   */
  files?: string;
  /** Compilation scale denominator (DSPM_CSCL), e.g. 12000. */
  compilationScale?: number;
  /**
   * The export states which spatial records are not surveyed
   * (`QUAPOS.geojson`), so land and shoreline objects are placed by the
   * compilation scale rather than by the survey's CATZOC (plan §4.4).
   */
  positionQuality?: boolean;
}

/**
 * Plotting accuracy of a chart compiled at scale 1:`scale`, as a 1σ in
 * metres: 1 mm on the chart read as a ~95 % bound, as CATZOC bounds are.
 */
export function compilationSigma(scale: number): number {
  return (scale * 0.001) / 2;
}

export interface CellCatalogue {
  version: 1;
  cells: CellInfo[];
}

/**
 * The third character of an ENC cell name is its navigational purpose
 * (usage band) 1–6. Names that do not follow the convention return
 * undefined so the caller must supply the band explicitly.
 */
export function usageBandFromName(name: string): number | undefined {
  return usageBand(Number(name.charAt(2)));
}

function usageBand(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= 6 ? n : undefined;
}

/**
 * The usage band of a compilation scale 1:`scale`, by the IHO S-65 scale
 * ranges: overview below 1:1 500 000, general to 1:350 000, coastal to
 * 1:90 000, approach to 1:22 000, harbour to 1:4 000, berthing above it.
 */
export function usageBandFromScale(scale: number | undefined): number | undefined {
  if (scale === undefined || !(scale > 0)) {
    return undefined;
  }
  const limits = [1_500_000, 350_000, 90_000, 22_000, 4_000];
  const i = limits.findIndex((limit) => scale >= limit);
  return i < 0 ? 6 : i + 1;
}

/**
 * A cell's usage band: the third character of its name, else the intended
 * usage of its DSID record (`DSID_INTU`), else its compilation scale. Inland
 * ENC cells carry 7 in both (Rijkswaterstaat's 1R7WAD07, 1:2 000), so they
 * fall to the scale: berthing.
 */
export function usageBandOf(
  name: string,
  intu: number | undefined,
  scale: number | undefined
): number | undefined {
  return usageBandFromName(name) ?? usageBand(intu) ?? usageBandFromScale(scale);
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function codes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list = value.filter((v): v is number => finiteOrUndefined(v) !== undefined);
  return list.length > 0 ? list : undefined;
}

function parseCell(raw: unknown, index: number): CellInfo {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`cells[${index}] is not an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name === "") {
    throw new Error(`cells[${index}].name must be a non-empty string`);
  }
  const band = finiteOrUndefined(r.band) ?? usageBandFromName(r.name);
  if (band === undefined || band < 1 || band > 6) {
    throw new Error(`cells[${index}] (${r.name}) has no usage band`);
  }
  return {
    name: r.name,
    edition: finiteOrUndefined(r.edition) ?? 0,
    update: finiteOrUndefined(r.update) ?? 0,
    issueDate: typeof r.issueDate === "string" ? r.issueDate : undefined,
    band,
    verticalDatum: finiteOrUndefined(r.verticalDatum),
    soundingDatum: finiteOrUndefined(r.soundingDatum),
    datumAreas: codes(r.datumAreas),
    source: typeof r.source === "string" ? r.source : undefined,
    files: typeof r.files === "string" ? r.files : undefined,
    compilationScale: finiteOrUndefined(r.compilationScale),
    positionQuality: r.positionQuality === true ? true : undefined
  };
}

/** Validates a parsed `cells.json`; throws naming the first malformed entry. */
export function parseCatalogue(json: unknown): CellCatalogue {
  if (typeof json !== "object" || json === null) {
    throw new Error("cells.json must be an object");
  }
  const raw = json as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(`cells.json version ${String(raw.version)} is not supported`);
  }
  if (!Array.isArray(raw.cells)) {
    throw new Error("cells.json must contain a cells array");
  }
  return { version: 1, cells: raw.cells.map(parseCell) };
}
