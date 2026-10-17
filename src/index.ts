import type { Path, Plugin, PluginRouter, ServerAPI } from "@signalk/server-api";
import { manifestProvider, PLUGIN_ID } from "./api/manifest";
import { registerRoutes } from "./api/routes";
import type { PluginConfig } from "./config";
import { parseConfig, SCHEMA } from "./config";
import type { EngineStatus } from "./foundation/state";
import { createStatus, PATHS } from "./foundation/state";
import { statusReport } from "./status-report";
import type { IndexLoad } from "./index-loader";
import { loadOrBuildIndex } from "./index-loader";
import type { Clock } from "./monitor";
import { Monitor, SYSTEM_CLOCK } from "./monitor";
import fs from "fs";
import path from "path";

// lib/index.js and src/index.ts both sit one level below package.json.
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

export = function underkeel(app: ServerAPI, clock: Clock = SYSTEM_CLOCK): Plugin {
  let monitor: Monitor | undefined;
  let load: IndexLoad | undefined;
  let stopped: EngineStatus = createStatus("off", "plugin not started", new Date(clock.now()));

  return {
    id: PLUGIN_ID,
    name: "Under-Keel Awareness",
    description:
      "Look-ahead grounding risk, route checks and a living chart. Advisory only: not for navigation.",

    schema: SCHEMA,

    start(options: unknown): void {
      const config: PluginConfig = parseConfig(options);
      load = loadOrBuildIndex(config, app.getDataDirPath());
      if (load.reason) {
        app.setPluginError(load.reason);
      }
      monitor = new Monitor(app, PLUGIN_ID, config, load.index, load.reason, clock);
      monitor.start();
      app.registerResourceProvider(manifestProvider(VERSION));
    },

    stop(): void {
      monitor?.stop();
      monitor = undefined;
      stopped = createStatus("off", "plugin stopped", new Date(clock.now()));
      app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              { path: PATHS.state as Path, value: "off" },
              { path: PATHS.clearance as Path, value: null },
              { path: PATHS.timeToShoal as Path, value: null },
              {
                path: PATHS.notification as Path,
                value: { state: "normal", method: [], message: "UKC monitoring stopped" } as never
              }
            ]
          }
        ]
      });
    },

    registerWithRouter(router: PluginRouter): void {
      registerRoutes(router, {
        status: () => statusReport({ load, monitor, stopped, now: clock.now() }),
        envelope: () =>
          monitor
            ? { rev: monitor.envelope.rev, envelope: monitor.envelope.envelope }
            : { rev: 0, envelope: { type: "FeatureCollection", features: [] } }
      });
    }
  };
};
