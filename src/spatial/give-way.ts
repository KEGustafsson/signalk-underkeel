import type { ChartFeature } from "../ingest/features";
import { FLAGS } from "./node-values";

/** A feature reaching a tile, and whether it contains the whole tile. */
interface Reaching {
  item: { f: ChartFeature };
  full: boolean;
}

/** A dredged area, not a point. */
export const isDredgedArea = (h: Reaching): boolean =>
  h.item.f.role === "depth" &&
  h.item.f.dredged &&
  !h.item.f.hazard &&
  h.item.f.geom.type === "polygon";

/**
 * `hits` without the depth areas (DEPARE) of a cell whose dredged areas cover the tile, alone
 * or side by side (`covers`, for several that each reach only part of it). An ENC's depth and
 * dredged areas never overlap; the Traficom WFS cell lays the FTIA's swept fairway areas over
 * the depth area that charts the channel with its banks (`ingest/wfs-ftia.ts`), and there the
 * swept depth is the charted one. Soundings, rocks, land and other cells' features stay.
 */
export function giveWay<H extends Reaching>(hits: H[], covers: (own: H[]) => boolean): H[] {
  const decided = dredgedCells(hits, covers);
  return decided.size === 0
    ? hits
    : hits.filter((h) => !(h.item.f.objectClass === "DEPARE" && decided.has(h.item.f.cellRef)));
}

/** The cells whose dredged areas cover the tile, one alone or several side by side. */
export function dredgedCells<H extends Reaching>(
  hits: H[],
  covers: (own: H[]) => boolean
): Set<number> {
  const dredged = hits.filter(isDredgedArea);
  const cells = new Set<number>();
  for (const cell of new Set(dredged.map((h) => h.item.f.cellRef))) {
    const own = dredged.filter((h) => h.item.f.cellRef === cell);
    if (own.some((h) => h.full) || (own.length > 1 && covers(own))) {
      cells.add(cell);
    }
  }
  return cells;
}

/**
 * A leaf's flags from what reaches it: NO_COVERAGE without a covering band, SWEPT or DREDGED
 * where such an area covers it (`dredged`: several side by side, `dredgedCells`), and
 * UNASSESSED without an assessed survey.
 */
export function tileFlags(
  hits: Reaching[],
  t: { bandFull: number | undefined; assessed: boolean; dredged: boolean }
): number {
  let flags = t.bandFull === undefined ? FLAGS.NO_COVERAGE : 0;
  if (t.dredged) {
    flags |= FLAGS.DREDGED;
  }
  for (const h of hits) {
    const f = h.item.f;
    if (f.role === "swept" && h.full) {
      flags |= FLAGS.SWEPT;
    } else if (f.role === "depth" && f.dredged && h.full) {
      flags |= FLAGS.DREDGED;
    }
  }
  return t.assessed ? flags : flags | FLAGS.UNASSESSED;
}
