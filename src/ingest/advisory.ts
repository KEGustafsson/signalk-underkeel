import { ODC_CELL_NAME, ODC_NOTICE, ODC_SOURCE } from "./odc";
import { WFS_CELL_NAME, WFS_NOTICE, WFS_SOURCE } from "./wfs";

/**
 * The cells the plugin writes itself for the box around the vessel, from sources not for
 * navigation: the Traficom WFS and Open Data Charts. Neither is an ENC: an index of them alone
 * holds no charted hazards, and their tiles carry NOT_FOR_NAVIGATION (plan §4.2).
 */

export { ODC_SOURCE, WFS_SOURCE };

const NOTICES: ReadonlyMap<string, string> = new Map([
  [WFS_SOURCE, WFS_NOTICE],
  [ODC_SOURCE, ODC_NOTICE]
]);

/** The DSID names of those cells, by source. */
export const ADVISORY_CELL_NAMES: ReadonlyMap<string, string> = new Map([
  [WFS_SOURCE, WFS_CELL_NAME],
  [ODC_SOURCE, ODC_CELL_NAME]
]);

export const isAdvisorySource = (source: string | undefined): boolean =>
  source !== undefined && NOTICES.has(source);

/**
 * Why water from an advisory cell is never `normal`: the notice of each advisory source among
 * `sources`, the Traficom WFS's when none is named.
 */
export function advisoryNotice(sources: Iterable<string | undefined>): string {
  const named = new Set<string>();
  for (const s of sources) {
    const notice = s === undefined ? undefined : NOTICES.get(s);
    if (notice !== undefined) {
      named.add(notice);
    }
  }
  return named.size === 0 ? WFS_NOTICE : [...named].join("; ");
}

const NAMES: ReadonlyMap<string, string> = new Map([
  [WFS_SOURCE, "Traficom WFS"],
  [ODC_SOURCE, "Open Data Charts"]
]);

/** The name an advisory source goes by in a reason. */
export const advisoryName = (source: string): string => NAMES.get(source) ?? source;

/** The settings an advisory source is on with. */
export interface AdvisorySettings {
  wfs?: unknown;
  openDataCharts?: unknown;
}

/** Whether advisory `source` is on in `cfg`. */
export const advisoryOn = (cfg: AdvisorySettings, source: string): boolean =>
  Boolean(source === WFS_SOURCE ? cfg.wfs : source === ODC_SOURCE && cfg.openDataCharts);

const holds = (cells: readonly { source?: string }[] | undefined, source: string): boolean =>
  cells?.some((c) => c.source === source) ?? false;

/** Why `cells` are stale: they hold the depths of an advisory source that is off in `cfg`. */
export function staleNote(
  cfg: AdvisorySettings,
  cells: readonly { source?: string }[] | undefined
): string | undefined {
  const off = [...ADVISORY_CELL_NAMES.keys()].find((s) => !advisoryOn(cfg, s) && holds(cells, s));
  return off && `holds ${advisoryName(off)} depths and that source is off`;
}

/** Why `cells` are stale: they hold no cell of one of the advisory cells' `sources` (none: WFS). */
export function lackingNote(
  sources: readonly (string | undefined)[],
  cells: readonly { source?: string }[] | undefined
): string | undefined {
  const lacking = sources.map((s) => s ?? WFS_SOURCE).find((s) => !holds(cells, s));
  return lacking && `lacks the ${advisoryName(lacking)} cell`;
}

/**
 * A saved box's source stamps `was`, less those of the advisory cells `now` lacks while their
 * source is on in `cfg`: a cell left out of the start, torn or gone, is written again by the
 * box service, and the saved index holds its depths meanwhile. A cell whose source is off
 * stays, so its depths do not outlive the source.
 */
export function keptStamps(
  was: readonly string[],
  now: readonly string[],
  cfg: AdvisorySettings
): string[] {
  const cellOf = (key: string): string | undefined =>
    [...ADVISORY_CELL_NAMES].find(([, name]) => key.startsWith(`${name} edition `))?.[0];
  const present = new Set(now.map(cellOf));
  return was.filter((k) => {
    const source = cellOf(k);
    return source === undefined || present.has(source) || !advisoryOn(cfg, source);
  });
}

/**
 * The notes the plugin status adds while advisory depths are in use, each unless `reason`
 * already gives it: the WFS licence while that source is on in `cfg`, the Open Data Charts
 * notice while the index's `cells` hold its depths.
 */
export function licenceNotes(
  cfg: { wfs?: unknown },
  cells: readonly { source?: string }[] | undefined,
  reason: string
): string[] {
  const odc = cells?.some((c) => c.source === ODC_SOURCE) ?? false;
  return [...(cfg.wfs ? [WFS_NOTICE] : []), ...(odc ? [ODC_NOTICE] : [])].filter(
    (n) => !reason.includes(n)
  );
}
