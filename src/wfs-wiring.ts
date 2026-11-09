import fs from "fs";
import path from "path";
import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "./api-wiring";
import type { PluginConfig, WfsConfig } from "./config";
import type { Rect } from "./foundation/geo";
import { toMercator } from "./foundation/geo";
import { cellCacheDir } from "./index-loader";
import { indexSource } from "./index-source";
import type { SharedAreaAnswer, SharedAreaCell } from "./shared-enc";
import { ALL_COLLECTIONS, requestSharedArea, sharedCellsIn, sharedEncApi } from "./shared-enc";
import type { Bbox } from "./ingest/wfs";
import { WFS_SOURCE } from "./ingest/wfs";
import { startLivechart } from "./livechart-service";
import { cellsNear } from "./livechart/rebind";
import type { FetchLike } from "./model/fmi";
import type { Clock } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";
import { autoCapKm } from "./box-sizing";
import type { AreaRequests, EncBoxConfig, IndexBuilder } from "./wfs-service";
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
 * The asking a configuration does: every new box asks the chosen charts provider for its
 * cells, which it downloads into a chart set of its own; none without a provider.
 */
export function areaRequests(
  config: Pick<PluginConfig, "chartsProviderEnc">,
  app: Pick<ServerAPI, "error" | "debug">
): AreaRequests | undefined {
  return config.chartsProviderEnc === ALL_COLLECTIONS ? askForArea(app) : undefined;
}

/** How soon, and how late, a box is asked about again: Charts Provider starting, or busy. */
export const AREA_ASK_MIN_MS = 60_000;
export const AREA_ASK_MAX_MS = 30 * 60_000;
const ASK_STARTING_MS = 5 * 60_000;

/**
 * What the provider said of a box, as the status gives it when the vessel has no chart
 * coverage: from its answer to the area request and the cells it has stored there (`cells`,
 * undefined when it cannot tell). Undefined when it has cells there and is not downloading:
 * a gap at the vessel is then the charts'.
 */
export function areaNote(
  answer: SharedAreaAnswer | undefined,
  cells: readonly SharedAreaCell[] | undefined,
  running = sharedEncApi() !== undefined
): string | undefined {
  if (answer === undefined) {
    return unaskedNote(running);
  }
  if (answer.started) {
    return "Charts Provider is downloading the ENC around the vessel";
  }
  if (cells === undefined) {
    return `Charts Provider: ${answer.reason}`;
  }
  if (cells.length > 0) {
    return undefined;
  }
  // Accepted and not started: no free ENC covers the area, or its download waits for the
  // internet connection; the provider's reason says which.
  return answer.accepted
    ? `Charts Provider has no ENC for this area: ${answer.reason}`
    : `Charts Provider has no ENC for this area and does not download it: ${answer.reason}`;
}

/** Why the charts provider could not be asked: not running, or a version without `requestArea`. */
function unaskedNote(running: boolean): string {
  return running
    ? "Charts Provider is too old to be asked for the ENC around the vessel: update it"
    : "Charts Provider is not running";
}

/**
 * Asks the charts provider for each box's cells, logging its answer when it changes, and says
 * when to ask again: when the provider says so, or is not running yet.
 */
function askForArea(app: Pick<ServerAPI, "error" | "debug">): AreaRequests {
  let last: string | undefined;
  let note: string | undefined;
  return {
    // A provider stopped since its answer leaves that answer stale: it is not running now.
    note: () => (sharedEncApi() === undefined ? unaskedNote(false) : note),
    ask: (bbox) => {
      const api = sharedEncApi();
      const answer = requestSharedArea(bbox, api);
      note = areaNote(answer, answer === undefined ? undefined : sharedCellsIn(bbox, api), !!api);
      const line =
        answer === undefined
          ? unaskedNote(!!api)
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
    }
  };
}

export function startWfs(
  w: WfsWiring,
  config: WfsConfig | EncBoxConfig,
  dirName = "wfs"
): WfsService {
  const dir = path.join(w.app.getDataDirPath(), dirName);
  fs.mkdirSync(dir, { recursive: true });
  const area = areaRequests(w.config, w.app);
  return new WfsService({
    config,
    dir,
    indexDir: w.config.indexDir ?? path.join(w.app.getDataDirPath(), "index"),
    cacheDir: cellCacheDir(w.app.getDataDirPath()),
    leafZoom: w.config.leafZoom,
    source: indexSource(w.config),
    area,
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
      // With no index in use the failure is why the look-ahead is off: an error, not "waiting",
      // with what the charts provider said of the box, as when it is downloading its cells.
      const { load, monitor } = w.state;
      if (load && !load.index) {
        const note = area?.note();
        const reason = note === undefined ? m : `${m}; ${note}`;
        w.state.load = { ...load, reason };
        monitor?.noIndex(reason);
      }
    }
  });
}
