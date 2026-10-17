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
  const c = name.charAt(2);
  const band = Number(c);
  return Number.isInteger(band) && band >= 1 && band <= 6 ? band : undefined;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    soundingDatum: finiteOrUndefined(r.soundingDatum)
  };
}

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
