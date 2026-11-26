import type { LonLat } from "./foundation/geo";
import type { WfsConfig } from "./config";
import type { WfsRefresher } from "./build-process";
import type { BoxRebuild, BoxSizing } from "./box-status";
import type { BoxWarmer } from "./cell-warm";
import type { OdcRecord, OdcSource } from "./odc-box";
import type { Bbox } from "./ingest/wfs";
import type { Clock } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";

/** The types of the box service (`wfs-service.ts`). */

/** The box in use, as saved in `<data dir>/wfs/box.json`. */
export interface WfsBox extends OdcRecord {
  bbox: Bbox;
  centre: LonLat;
  radiusKm: number;
  /** Absent for a box of ENC cells alone. */
  catzoc?: number;
  fetchedAt: string;
  features: { depthAreas: number; dredgedAreas: number; soundings: number };
  /** How long its download and index build took; the next box is planned on it. */
  durationMs?: number;
}

export interface WfsStatus {
  notice: string;
  box?: WfsBox;
  busy: boolean;
  lastError?: string;
  rebuild?: BoxRebuild;
  sizing: BoxSizing;
  /** One line on the rebuild and the box size, for the plugin status and the panel. */
  summary?: string;
}

/** A box of ENC cells around the vessel, with no WFS download. */
export interface EncBoxConfig {
  radiusKm: number;
}

export interface WfsServiceDeps {
  config: WfsConfig | EncBoxConfig;
  /** `<data dir>/wfs`, or the ENC box's directory: holds box.json and any WFS cell. */
  dir: string;
  indexDir: string;
  /** The cell cache the builds use (`BuildJob.cacheDir`); none when absent. */
  cacheDir?: string;
  /** The ENC source the cells come from (`BuildJob.source`); none when absent. */
  source?: string;
  /**
   * The charts provider, asked for the cells of each box a refresh starts building, and what
   * it last answered (`wfs-wiring.ts`).
   */
  area?: AreaRequests;
  leafZoom: number;
  /**
   * The S-57 cells directory, scanned by the refresh off the event loop; its cells are built
   * before the WFS cell so they keep their catalogue order.
   */
  cellsDir?: string;
  /** Builds the ENC cells in the box too (plan §4.2), not whole. */
  inBox: boolean;
  /** The index in use; with none, a refresh is due whatever the saved box says. */
  index: () => ChartIndex | undefined;
  refresh: WfsRefresher;
  clock: Pick<Clock, "now" | "setInterval" | "clearInterval">;
  position: () => LonLat | undefined;
  /** Fresh speed (m/s) and course (radians) over ground, when both are known. */
  motion: () => { sog: number; cog: number } | undefined;
  /** The look-ahead's reach: `distance`, or `minHorizon` seconds at the current speed. */
  lookahead: { distance: number; minHorizon: number };
  /**
   * The radius the box may grow to at speed (`box-sizing.ts`), km; it never shrinks below
   * `config.radiusKm`. Without it the box keeps the configured radius.
   */
  maxRadiusKm?: number;
  /**
   * Hands a rebuilt index over. `changed` holds the boxes of the index in use and the new
   * one when this service built both, so only the WFS cell differs between them.
   */
  onIndex: (index: ChartIndex, changed?: Bbox[]) => void | Promise<void>;
  /** Fills the cell cache between builds (`cell-warm.ts`); none when absent. */
  warm?: BoxWarmer;
  /** Open Data Charts depths for the box, with the CATZOC assumed for them; none when off. */
  odc?: OdcSource;
  error: (message: string) => void;
}

/** Asks the charts provider for each new box's cells, and says what it last answered. */
export interface AreaRequests {
  /** Asks for `bbox`'s cells; says when to ask about it again, ms, or undefined for never. */
  ask: (bbox: Bbox) => number | undefined;
  /** What the provider last said, as a no-coverage reason gives it; undefined before asking. */
  note: () => string | undefined;
}
