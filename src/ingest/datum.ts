import type { CellInfo } from "./cells";

/**
 * Vertical datum per cell (plan §4.5). A cell's depths are below its
 * sounding datum (S-57 VERDAT code from M_SDAT, else M_VDAT); a water-level
 * series is only usable for that cell when it is reported above the same
 * datum. Each mapping carries a σ for how well the series' reference
 * matches the chart's.
 */

/** Water-level series a provider can report in. */
export type LevelSeries = "mw" | "n2000";

export interface DatumMapping {
  /** S-57 VERDAT code. */
  verdat: number;
  series: LevelSeries;
  /** 1σ of the datum match, metres. */
  sigma: number;
}

/**
 * FMI reports sea level above theoretical mean water ("mw") and above N2000.
 * VERDAT 3 (MSL), 19 (approximate MSL) and 26 (mean water level) read as
 * mean water. Older Finnish cells use the mean water of their survey epoch,
 * which land uplift moves away from the current theoretical mean water by a
 * few millimetres a year, hence σ 0.1 m. N2000 has no VERDAT code of its own;
 * a cell that uses it is mapped in the plugin configuration.
 */
export const DEFAULT_DATUMS: readonly DatumMapping[] = [
  { verdat: 3, series: "mw", sigma: 0.1 },
  { verdat: 19, series: "mw", sigma: 0.1 },
  { verdat: 26, series: "mw", sigma: 0.1 }
];

/** σ for a cell whose datum is unknown or unmapped (plan §4.5). */
export const UNKNOWN_DATUM_SIGMA = 0.5;

/** How a group of cells relates to the water-level series. */
export interface DatumUse {
  /** The series to read; unknown datums read "mw" with UNKNOWN_DATUM_SIGMA. */
  series: LevelSeries;
  sigma: number;
  /** VERDAT code, undefined when the cell states none. */
  verdat?: number;
  known: boolean;
  /** Datum-area VERDAT codes that differ from `verdat`, which make the cells unknown. */
  datumAreas?: number[];
  cells: string[];
}

function useFor(
  verdat: number | undefined,
  datumAreas: number[] | undefined,
  mappings: readonly DatumMapping[]
): DatumUse {
  const m = datumAreas ? undefined : mappings.find((d) => d.verdat === verdat);
  if (m) {
    return { series: m.series, sigma: m.sigma, verdat, known: true, cells: [] };
  }
  const unknown = { series: "mw" as const, sigma: UNKNOWN_DATUM_SIGMA, verdat, known: false };
  return datumAreas ? { ...unknown, datumAreas, cells: [] } : { ...unknown, cells: [] };
}

/**
 * The datum uses of a catalogue, one per distinct VERDAT code and set of
 * datum areas. A cell with datum areas on another VERDAT is unknown: its
 * depths are on more than one datum and the plugin does not map them per area.
 */
export function datumUses(
  cells: readonly CellInfo[],
  mappings: readonly DatumMapping[] = DEFAULT_DATUMS
): DatumUse[] {
  const byKey = new Map<string, DatumUse>();
  for (const cell of cells) {
    const verdat = cell.soundingDatum ?? cell.verticalDatum;
    const key = `${String(verdat)} ${cell.datumAreas?.join(",") ?? ""}`;
    let use = byKey.get(key);
    if (!use) {
      use = useFor(verdat, cell.datumAreas, mappings);
      byKey.set(key, use);
    }
    use.cells.push(cell.name);
  }
  return [...byKey.values()];
}
