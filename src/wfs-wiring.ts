import fs from "fs";
import path from "path";
import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "./api-wiring";
import type { PluginConfig, WfsConfig } from "./config";
import { cellDirectories } from "./index-loader";
import { startLivechart } from "./livechart-service";
import type { FetchLike } from "./model/fmi";
import type { Clock } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";
import type { IndexBuilder } from "./wfs-service";
import { WfsService } from "./wfs-service";

/** What the Traficom WFS box needs from the running plugin. */
export interface WfsWiring {
  app: Pick<ServerAPI, "getDataDirPath" | "resourcesApi" | "error">;
  clock: Clock;
  state: PluginState;
  config: PluginConfig;
  fetch: FetchLike;
  build: IndexBuilder;
}

/** Swaps an index rebuilt for a new WFS box into the running services. */
function useIndex(w: WfsWiring, index: ChartIndex): void {
  const { monitor, load } = w.state;
  if (!monitor || !load) {
    return;
  }
  w.state.load = { index, indexDir: load.indexDir, built: true };
  monitor.setIndex(index);
  if (w.state.livechart) {
    w.state.livechart.rebind(index.pyramid);
  } else {
    w.state.livechart = startLivechart(w.app, w.clock, w.config, index, monitor);
  }
}

export function startWfs(w: WfsWiring, wfs: WfsConfig): WfsService {
  const dir = path.join(w.app.getDataDirPath(), "wfs");
  fs.mkdirSync(dir, { recursive: true });
  return new WfsService({
    config: wfs,
    dir,
    indexDir: w.config.indexDir ?? path.join(w.app.getDataDirPath(), "index"),
    leafZoom: w.config.leafZoom,
    encDirs: () => cellDirectories(w.config.cellsDir),
    fetch: w.fetch,
    build: w.build,
    clock: w.clock,
    position: () => w.state.monitor?.nav.position?.value,
    onIndex: (index) => useIndex(w, index),
    error: (m) => w.app.error(m)
  });
}
