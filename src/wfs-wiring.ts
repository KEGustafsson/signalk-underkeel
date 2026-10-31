import fs from "fs";
import path from "path";
import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "./api-wiring";
import type { PluginConfig, WfsConfig } from "./config";
import type { Rect } from "./foundation/geo";
import { toMercator } from "./foundation/geo";
import { cellCacheDir } from "./index-loader";
import { indexSource } from "./index-source";
import { ALL_COLLECTIONS, requestSharedArea } from "./shared-enc";
import type { Bbox } from "./ingest/wfs";
import { WFS_SOURCE } from "./ingest/wfs";
import { startLivechart } from "./livechart-service";
import { cellsNear } from "./livechart/rebind";
import type { FetchLike } from "./model/fmi";
import type { Clock } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";
import { autoCapKm } from "./box-sizing";
import type { EncBoxConfig, IndexBuilder } from "./wfs-service";
import {
  inThreadRefresher,
  workerBuilder,
  workerHeapLimitMb,
  workerRefresher,
  WfsService
} from "./wfs-service";

/** What the Traficom WFS box needs from the running plugin. */
export interface WfsWiring {
  app: Pick<ServerAPI, "getDataDirPath" | "resourcesApi" | "error" | "debug">;
  clock: Clock;
  state: PluginState;
  config: PluginConfig;
  fetch: FetchLike;
  build: IndexBuilder;
}

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The catalogues list the same cells in the same order, the WFS cell aside. */
function sameCells(a: ChartIndex, b: ChartIndex): boolean {
  const key = (i: ChartIndex) =>
    i.catalogue.cells.map((c) => (c.source === WFS_SOURCE ? WFS_SOURCE : JSON.stringify(c)));
  return key(a).join("\n") === key(b).join("\n");
}

const mercatorRect = ([w, s, e, n]: Bbox): Rect => {
  const [minX, minY] = toMercator(w, s);
  const [maxX, maxY] = toMercator(e, n);
  return { minX, minY, maxX, maxY };
};

/**
 * Swaps an index rebuilt for a new WFS box into the running services. The living chart is
 * moved over in slices first, each its own turn of the event loop, and the index is swapped
 * in the same turn as the last step, so no query sees the new index without the living
 * chart's adjustments (invariant 5). When only the WFS cell changed, only the cells near the
 * old and new boxes are re-judged.
 */
async function useIndex(w: WfsWiring, index: ChartIndex, changed?: Bbox[]): Promise<void> {
  const { monitor, load } = w.state;
  if (!monitor || !load) {
    return;
  }
  const lc = w.state.livechart;
  let apply = (): void => undefined;
  if (lc) {
    const only = changed && load.index && sameCells(load.index, index);
    const affected = only ? cellsNear(changed.map(mercatorRect)) : () => true;
    await pause();
    apply = await lc.prepareRebind(index.pyramid, affected, pause);
    if (w.state.monitor !== monitor || w.state.livechart !== lc) {
      return;
    }
  }
  apply();
  w.state.load = { index, indexDir: load.indexDir, built: true };
  monitor.setIndex(index);
  if (!lc) {
    w.state.livechart = startLivechart(w.app, w.clock, w.config, index, monitor);
  }
}

/** SOG and COG while both are fresh by the look-ahead's staleness limit. */
function freshMotion(w: WfsWiring): { sog: number; cog: number } | undefined {
  const nav = w.state.monitor?.nav;
  const limit = w.config.lookahead.staleAfter * 1000;
  const now = w.clock.now();
  const sog = nav?.sog;
  const cog = nav?.cog;
  return sog && cog && now - sog.at <= limit && now - cog.at <= limit
    ? { sog: sog.value, cog: cog.value }
    : undefined;
}

/**
 * The box kept around the vessel: the Traficom WFS box when that source is on, else a box
 * the ENC cells alone are built in; none when `boxRadiusKm` is 0 and the WFS is off.
 */
export function startBox(w: WfsWiring): WfsService | undefined {
  const { wfs, cellsDir, boxRadiusKm } = w.config;
  if (wfs) {
    return startWfs(w, wfs);
  }
  return cellsDir && boxRadiusKm > 0
    ? startWfs(w, { radiusKm: boxRadiusKm }, "chart-box")
    : undefined;
}

/**
 * What each new box tells the charts provider: asks for its cells with `chartsProviderArea`
 * on, and only while the source is `*`, as they arrive in a chart set of their own.
 */
export function areaRequests(
  config: Pick<PluginConfig, "chartsProviderArea" | "chartsProviderEnc">,
  app: Pick<ServerAPI, "error" | "debug">
): ((bbox: Bbox) => number | undefined) | undefined {
  return config.chartsProviderArea && config.chartsProviderEnc === ALL_COLLECTIONS
    ? askForArea(app)
    : undefined;
}

/** How soon, and how late, a box is asked about again: Charts Provider starting, or busy. */
export const AREA_ASK_MIN_MS = 60_000;
export const AREA_ASK_MAX_MS = 30 * 60_000;
const ASK_STARTING_MS = 5 * 60_000;

/**
 * Asks the charts provider for each box's cells, logging its answer when it changes, and says
 * when to ask again: when the provider says so, or is not running yet.
 */
function askForArea(app: Pick<ServerAPI, "error" | "debug">): (bbox: Bbox) => number | undefined {
  let last: string | undefined;
  return (bbox) => {
    const answer = requestSharedArea(bbox);
    const line =
      answer === undefined
        ? "Charts Provider cannot be asked for the ENC around the vessel: it is not running, or too old"
        : `Charts Provider, asked for the ENC around the vessel: ${answer.reason}`;
    if (line !== last) {
      last = line;
      if (answer?.accepted === true) {
        app.debug(line);
      } else {
        app.error(line);
      }
    }
    const ms = answer === undefined ? ASK_STARTING_MS : answer.retryAfterMs;
    return typeof ms === "number" && Number.isFinite(ms)
      ? Math.min(AREA_ASK_MAX_MS, Math.max(AREA_ASK_MIN_MS, ms))
      : undefined;
  };
}

export function startWfs(
  w: WfsWiring,
  config: WfsConfig | EncBoxConfig,
  dirName = "wfs"
): WfsService {
  const dir = path.join(w.app.getDataDirPath(), dirName);
  fs.mkdirSync(dir, { recursive: true });
  return new WfsService({
    config,
    dir,
    indexDir: w.config.indexDir ?? path.join(w.app.getDataDirPath(), "index"),
    cacheDir: cellCacheDir(w.app.getDataDirPath()),
    leafZoom: w.config.leafZoom,
    source: indexSource(w.config),
    onBox: areaRequests(w.config, w.app),
    cellsDir: w.config.cellsDir,
    inBox: w.config.boxRadiusKm > 0,
    index: () => w.state.load?.index,
    // The build process fetches with its own global fetch; an injected builder, as in the tests,
    // gets the download on this thread with the injected fetch.
    refresh: w.build === workerBuilder ? workerRefresher : inThreadRefresher(w.fetch, w.build),
    clock: w.clock,
    position: () => w.state.monitor?.nav.position?.value,
    motion: () => freshMotion(w),
    lookahead: w.config.lookahead,
    maxRadiusKm: w.config.boxMaxRadiusKm || autoCapKm(workerHeapLimitMb()),
    onIndex: (index, changed) => useIndex(w, index, changed),
    error: (m) => {
      w.app.error(m);
      // With no index in use the failure is why the look-ahead is off: an error, not "waiting".
      const { load, monitor } = w.state;
      if (load && !load.index) {
        w.state.load = { ...load, reason: m };
        monitor?.noIndex(m);
      }
    }
  });
}
