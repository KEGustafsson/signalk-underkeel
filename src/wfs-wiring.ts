import fs from "fs";
import path from "path";
import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "./api-wiring";
import type { PluginConfig, WfsConfig } from "./config";
import { cellSources } from "./index-loader";
import type { Rect } from "./foundation/geo";
import { toMercator } from "./foundation/geo";
import type { Bbox } from "./ingest/wfs";
import { WFS_SOURCE } from "./ingest/wfs";
import { startLivechart } from "./livechart-service";
import { cellsNear } from "./livechart/rebind";
import type { FetchLike } from "./model/fmi";
import type { Clock } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";
import type { IndexBuilder } from "./wfs-service";
import { inThreadRefresher, workerBuilder, workerRefresher, WfsService } from "./wfs-service";

/** What the Traficom WFS box needs from the running plugin. */
export interface WfsWiring {
  app: Pick<ServerAPI, "getDataDirPath" | "resourcesApi" | "error">;
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

export function startWfs(w: WfsWiring, wfs: WfsConfig): WfsService {
  const dir = path.join(w.app.getDataDirPath(), "wfs");
  fs.mkdirSync(dir, { recursive: true });
  return new WfsService({
    config: wfs,
    dir,
    indexDir: w.config.indexDir ?? path.join(w.app.getDataDirPath(), "index"),
    leafZoom: w.config.leafZoom,
    encDirs: () => cellSources(w.config.cellsDir),
    // The worker fetches with its own global fetch; an injected builder, as in the tests,
    // gets the download on this thread with the injected fetch.
    refresh: w.build === workerBuilder ? workerRefresher : inThreadRefresher(w.fetch, w.build),
    clock: w.clock,
    position: () => w.state.monitor?.nav.position?.value,
    motion: () => freshMotion(w),
    lookahead: w.config.lookahead,
    onIndex: (index, changed) => useIndex(w, index, changed),
    error: (m) => w.app.error(m)
  });
}
