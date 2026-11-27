import fs from "fs";
import type { Bbox } from "./ingest/wfs";
import type { TileId } from "./ingest/mvt-decode";
import { coverageTiles, intersect, ODC_ZOOM, tilesToRead, writeStagedTile } from "./ingest/odc";

/**
 * The Open Data Charts tiles Charts Provider serves, read in-process through its `chartTiles`
 * PropertyValue (signalk-charts-provider-simple 2.26 and later, whose `charts()` lists the
 * charts and marks those put together from an Open Data Charts set). A secured server needs no
 * token. The box service stages the tiles of each box here, on the main thread, since the build
 * process cannot call another plugin; the process decodes them (`ingest/odc.ts`).
 */

/** The PropertyValue Charts Provider offers its chart tiles as. */
export const TILES_PROPERTY = "chartTiles";

/** The part of a chart `ChartTiles.charts()` lists that is read here. */
export interface TilesChart {
  id: string;
  format: string;
  bounds?: number[];
  maxzoom?: number;
  coverage?: unknown;
  openDataSet?: string;
}

/** The part of Charts Provider's `ChartTiles` used here. */
export interface ChartTilesApi {
  getTile(chartId: string, z: number, x: number, y: number): Promise<Uint8Array | null | undefined>;
  charts(): TilesChart[];
}

/** The part of the server's PropertyValues API used here. */
interface PropertyValues {
  onPropertyValues?: (
    name: string,
    cb: (history: ({ setter?: string; value: unknown } | undefined)[]) => void
  ) => () => void;
}

function isOffer(v: unknown): v is ChartTilesApi {
  const o = v as Partial<ChartTilesApi> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.getTile === "function" &&
    typeof o.charts === "function"
  );
}

/** One Open Data Charts chart meeting a box, the offer serving it and its covered tiles. */
interface OdcChart {
  offer: ChartTilesApi;
  id: string;
  covered: TileId[];
}

const isBbox = (b: unknown): b is Bbox =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));

/**
 * Whether `c` is an Open Data Charts vector chart stating that it reaches ODC_ZOOM, so its z15
 * tiles are its own, that may meet `bbox`.
 */
function meets(c: Partial<TilesChart> | null | undefined, bbox: Bbox): c is TilesChart {
  return (
    typeof c?.id === "string" &&
    typeof c.openDataSet === "string" &&
    c.format === "pbf" &&
    typeof c.maxzoom === "number" &&
    c.maxzoom >= ODC_ZOOM &&
    !(isBbox(c.bounds) && !intersect(c.bounds, bbox))
  );
}

/**
 * The Open Data Charts charts of `offers` meeting `bbox`, in a fixed order: vector charts that
 * reach ODC_ZOOM and state the tiles they fill (`coverage`), since only there is a tile read
 * known to be the chart's own data. A list that cannot be read counts as none, or with
 * `strict` throws.
 */
export function odcCharts(
  offers: readonly ChartTilesApi[],
  bbox: Bbox,
  strict = false
): OdcChart[] {
  const out: OdcChart[] = [];
  for (const offer of offers) {
    let charts: unknown;
    try {
      charts = offer.charts();
    } catch (err) {
      if (strict) {
        throw err;
      }
      continue;
    }
    if (!Array.isArray(charts)) {
      continue;
    }
    for (const c of charts as Partial<TilesChart>[]) {
      if (!meets(c, bbox)) {
        continue;
      }
      const covered = coverageTiles(c.coverage);
      if (covered.length > 0) {
        out.push({ offer, id: c.id, covered });
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How often staging yields to the event loop, in tiles. */
const YIELD_EVERY = 32;

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * How long one tile read, and staging as a whole, may take, ms. Charts Provider reads its
 * files in-process in milliseconds; one that hangs must not hold up the box.
 */
export interface StageLimits {
  tileMs: number;
  totalMs: number;
}

const STAGE_LIMITS: StageLimits = { tileMs: 10_000, totalMs: 300_000 };

/** `read`, rejected once `ms` pass or `signal` aborts first; leaves no timer behind. */
async function within<T>(
  read: Promise<T>,
  ms: number,
  signal: AbortSignal,
  what: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort = (): void => undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([read, stop]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** The box service's view of Open Data Charts (`WfsService`). */
export interface OdcTiles {
  /**
   * What the charts meeting `bbox` are now, to compare with the box's: null when the offers
   * list none, undefined while that cannot be known (no offer followed yet, as before Charts
   * Provider has started, or a list that cannot be read).
   */
  key(bbox: Bbox): string | null | undefined;
  /**
   * Writes the tiles of `bbox` the charts cover to `file`; how many, 0 when none. Rejects
   * when `signal` aborts, a read fails or takes too long, or a chart list cannot be read.
   */
  stage(bbox: Bbox, file: string, signal: AbortSignal): Promise<number>;
}

/** The offers taken last, one per setter. */
let offers: ChartTilesApi[] = [];

/**
 * Follows Charts Provider's `chartTiles` offers: the latest value of each setter that has the
 * calls read here is what `chartsProviderOdc` reads. Returns the call that stops following them
 * and forgets them. A server with no PropertyValues (a test harness) offers none.
 */
export function watchChartTiles(app: PropertyValues): () => void {
  if (typeof app.onPropertyValues !== "function") {
    return () => undefined;
  }
  const unsubscribe = app.onPropertyValues(TILES_PROPERTY, (history) => {
    const latest = new Map<string, unknown>();
    for (const entry of history) {
      if (entry) {
        latest.set(entry.setter ?? "", entry.value);
      }
    }
    offers = [...latest.values()].filter(isOffer);
  });
  return () => {
    unsubscribe();
    offers = [];
  };
}

/** The view over the offers `current()` gives at each call. */
export function odcTilesOf(
  current: () => readonly ChartTilesApi[],
  limits: StageLimits = STAGE_LIMITS
): OdcTiles {
  return {
    key: (bbox) => {
      const offered = current();
      let charts: OdcChart[];
      try {
        charts = odcCharts(offered, bbox, true);
      } catch {
        return undefined;
      }
      if (charts.length === 0) {
        return offered.length === 0 ? undefined : null;
      }
      return charts
        .map((c) => `${c.id} ${c.covered.map((t) => `${t.z}/${t.x}/${t.y}`).join(",")}`)
        .join("\n");
    },
    stage: async (bbox, file, signal) => {
      const charts = odcCharts(current(), bbox, true);
      if (charts.length === 0) {
        return 0;
      }
      const halt = (): void => {
        if (signal.aborted) {
          throw new Error("aborted");
        }
      };
      const deadline = Date.now() + limits.totalMs;
      const fd = fs.openSync(file, "w");
      let count = 0;
      try {
        let since = 0;
        for (const chart of charts) {
          for (const t of tilesToRead(bbox, chart.covered)) {
            halt();
            const left = deadline - Date.now();
            if (left <= 0) {
              throw new Error(`staging took over ${limits.totalMs / 1000} s`);
            }
            const data = await within(
              chart.offer.getTile(chart.id, t.z, t.x, t.y),
              Math.min(limits.tileMs, left),
              signal,
              `tile ${t.z}/${t.x}/${t.y}`
            );
            // An abort while the read was pending must not write its tile.
            halt();
            if (data instanceof Uint8Array && data.length > 0) {
              writeStagedTile(fd, { ...t, data });
              count++;
            }
            if (++since >= YIELD_EVERY) {
              since = 0;
              await pause();
            }
          }
        }
        halt();
      } finally {
        fs.closeSync(fd);
      }
      return count;
    }
  };
}

/** Open Data Charts through the offers followed now (`watchChartTiles`). */
export const chartsProviderOdc: OdcTiles = odcTilesOf(() => offers);
