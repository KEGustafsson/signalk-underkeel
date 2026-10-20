import type { Path, Plugin, PluginRouter, ServerAPI } from "@signalk/server-api";
import { mountAssets } from "./api/assets";
import { manifestProvider, PLUGIN_ID } from "./api/manifest";
import { registerRoutes } from "./api/routes";
import type { PluginConfig } from "./config";
import { parseConfig, SCHEMA } from "./config";
import type { EngineStatus } from "./foundation/state";
import { createStatus, PATHS } from "./foundation/state";
import { loadOrBuildIndex } from "./index-loader";
import type { Clock } from "./monitor";
import { Monitor, SYSTEM_CLOCK } from "./monitor";
import type { FetchLike } from "./model/fmi";
import { AckStore } from "./ack-store";
import type { PluginState } from "./api-wiring";
import { apiFor } from "./api-wiring";
import { stoppedNotification } from "./notifications";
import { loadZones } from "./zones";
import { startLivechart } from "./livechart-service";
import type { IndexBuilder } from "./wfs-service";
import { workerBuilder } from "./wfs-service";
import { startWfs } from "./wfs-wiring";
import fs from "fs";
import path from "path";

// lib/index.js and src/index.ts both sit one level below package.json.
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

function stopPlugin(app: ServerAPI, clock: Clock, state: PluginState): void {
  state.wfs?.stop();
  state.wfs = undefined;
  // A save that throws must not leave the monitor running or REST answering on the old index.
  try {
    state.livechart?.save();
  } catch (err) {
    app.error(`living chart not saved on stop: ${(err as Error).message}`);
  }
  state.livechart = undefined;
  state.monitor?.stop();
  // Without these the REST handlers would keep answering on the old index at chart datum.
  Object.assign(state, { monitor: undefined, load: undefined, config: undefined, acks: undefined });
  state.stopped = createStatus("off", "plugin stopped", new Date(clock.now()));
  app.handleMessage(PLUGIN_ID, {
    updates: [
      {
        values: [
          { path: PATHS.state as Path, value: "off" },
          { path: PATHS.clearance as Path, value: null },
          { path: PATHS.clearanceSigma as Path, value: null },
          { path: PATHS.risk as Path, value: null },
          { path: PATHS.timeToShoal as Path, value: null },
          { path: PATHS.escapeHeading as Path, value: null },
          { path: PATHS.envelopeRev as Path, value: null },
          { path: PATHS.waterLevel as Path, value: null },
          { path: PATHS.notification as Path, value: stoppedNotification() }
        ]
      }
    ]
  });
}

export = function underkeel(
  app: ServerAPI,
  clock: Clock = SYSTEM_CLOCK,
  fetch: FetchLike = globalThis.fetch,
  build: IndexBuilder = workerBuilder
): Plugin {
  const state: PluginState = {
    zoneErrors: [],
    stopped: createStatus("off", "plugin not started", new Date(clock.now()))
  };

  return {
    id: PLUGIN_ID,
    name: "Under-Keel Awareness",
    description:
      "Look-ahead grounding risk, route checks and a living chart. Advisory only: not for navigation.",

    schema: SCHEMA,

    start(options: unknown): void {
      const config = parseConfig(options);
      const wfs = config.wfs && startWfs({ app, clock, state, config, fetch, build }, config.wfs);
      const load = loadOrBuildIndex(
        config,
        app.getDataDirPath(),
        wfs?.savedCell() ? [wfs.cellDir] : []
      );
      const monitor = new Monitor(app, PLUGIN_ID, config, load.index, load.reason, clock, fetch);
      const acks = new AckStore(path.join(app.getDataDirPath(), "acks.json"));
      if (acks.error) {
        app.error(acks.error);
      }
      monitor.useAcks(acks);
      const livechart = startLivechart(app, clock, config, load.index, monitor);
      monitor.start();
      Object.assign(state, { config, load, monitor, acks, livechart, wfs, zoneErrors: [] });
      wfs?.start();
      void loadZones(config.mooringZones, (id) => app.resourcesApi.getResource("regions", id)).then(
        ({ zones, errors }) => {
          // A slow load from an earlier start must not report into this one.
          if (state.monitor !== monitor) {
            return;
          }
          monitor.setZones(zones);
          state.zoneErrors = errors;
          errors.forEach((e) => app.error(e));
        }
      );
      mountAssets(app);
      app.registerResourceProvider(manifestProvider(VERSION));
    },

    stop(): void {
      stopPlugin(app, clock, state);
    },

    registerWithRouter(router: PluginRouter): void {
      registerRoutes(router, apiFor(app, clock, state), (message) => app.error(message));
    }
  };
};
