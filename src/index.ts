import type { Path, Plugin, PluginRouter, ServerAPI } from "@signalk/server-api";
import { mountAssets } from "./api/assets";
import { manifestProvider, PLUGIN_ID } from "./api/manifest";
import { registerRoutes } from "./api/routes";
import { parseConfig } from "./config";
import { migrateConfig } from "./config-migrate";
import { adminSchema, flatten, formsFollowDependencies, UI_SCHEMA } from "./config-schema";
import type { SchemaHints } from "./config-schema";
import { schemaHints } from "./setup-checks";
import { persistMigration } from "./settings-service";
import type { EngineStatus } from "./foundation/state";
import { createStatus, PATHS } from "./foundation/state";
import { planIndex } from "./index-loader";
import { pendingLoad, settleAtStart } from "./index-startup";
import type { Clock } from "./monitor";
import { Monitor, SYSTEM_CLOCK } from "./monitor";
import type { FetchLike } from "./model/fmi";
import { AckStore } from "./ack-store";
import type { PluginState } from "./api-wiring";
import { apiFor } from "./api-wiring";
import { RequestQueue } from "./route-service";
import { stoppedNotification } from "./notifications";
import { loadZones } from "./zones";
import { keepBlocksNearVessel } from "./block-keeper";
import { startLivechart } from "./livechart-service";
import type { IndexBuilder } from "./wfs-service";
import { workerBuilder } from "./wfs-service";
import { startBox } from "./wfs-wiring";
import type { SharedEncWatch } from "./shared-enc";
import { watchSharedCells, withSharedCells } from "./shared-enc";
import fs from "fs";
import path from "path";

// lib/index.js and src/index.ts both sit one level below package.json.
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

function stopPlugin(app: ServerAPI, clock: Clock, state: PluginState): void {
  state.requests.abortAll("plugin stopped");
  state.wfs?.stop();
  state.wfs = undefined;
  // A save that throws must not leave the monitor running or REST answering on the old index.
  try {
    state.livechart?.stop();
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

/**
 * The admin form for this server: the essentials with expert settings
 * behind a checkbox where the admin UI forwards `dependencies`, every field
 * at once where it does not. The setup checks are decoration: a failure
 * there leaves them out rather than replace the form with the server's
 * error schema, which saving would write over the configuration.
 */
function formSchema(app: ServerAPI, state: PluginState): object {
  let hints: SchemaHints = {};
  try {
    hints = state.monitor ? schemaHints(app, state) : {};
  } catch (err) {
    app.error(`setup checks failed: ${(err as Error).message}`);
  }
  const schema = adminSchema(hints);
  const version = (app as { config?: { version?: unknown } }).config?.version;
  return formsFollowDependencies(version) ? schema : flatten(schema);
}

export = function underkeel(
  app: ServerAPI,
  clock: Clock = SYSTEM_CLOCK,
  fetch: FetchLike = globalThis.fetch,
  build: IndexBuilder = workerBuilder
): Plugin {
  const state: PluginState = {
    zoneErrors: [],
    stopped: createStatus("off", "plugin not started", new Date(clock.now())),
    requests: new RequestQueue()
  };
  let startup: AbortController | undefined;
  let shared: SharedEncWatch | undefined;

  return {
    id: PLUGIN_ID,
    name: "Under-Keel Awareness",
    description:
      "Look-ahead grounding risk, route checks and a living chart. Advisory only: not for navigation.",

    schema: () => formSchema(app, state),
    uiSchema: UI_SCHEMA,

    start(options: unknown, restart?: (config: object) => void): void {
      const migration = migrateConfig(options);
      persistMigration(app, options, migration);
      const config = withSharedCells(parseConfig(migration.config), app.getDataDirPath());
      const wfs = startBox({ app, clock, state, config, fetch, build });
      const plan = planIndex(config, app.getDataDirPath(), wfs?.savedCell() ? [wfs.cellDir] : []);
      const load = "load" in plan ? plan.load : pendingLoad(plan);
      const monitor = new Monitor(app, PLUGIN_ID, config, load.index, load.reason, clock, fetch);
      const acks = new AckStore(path.join(app.getDataDirPath(), "acks.json"));
      if (acks.error) {
        app.error(acks.error);
      }
      monitor.useAcks(acks);
      monitor.chartBox = wfs && (() => wfs.view());
      keepBlocksNearVessel(monitor, () => state.load?.index, clock, config.lookahead);
      const livechart = startLivechart(app, clock, config, load.index, monitor);
      monitor.start();
      Object.assign(state, { config, load, monitor, acks, livechart, wfs, zoneErrors: [] });
      Object.assign(state, { options: migration.config, restart });
      if ("load" in plan) {
        wfs?.start();
      } else {
        startup = settleAtStart({ app, clock, state, config, monitor, wfs }, plan, build);
      }
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
      shared = config.chartsProviderEnc
        ? watchSharedCells(config.chartsProviderEnc, clock, () => {
            // A start compares the cells with the saved index and rebuilds it when they changed.
            if (restart) {
              restart(migration.config);
            } else {
              app.error("the shared ENC cells changed; restart the plugin to index them");
            }
          })
        : undefined;
      mountAssets(app);
      app.registerResourceProvider(manifestProvider(VERSION));
    },

    stop(): void {
      shared?.stop();
      shared = undefined;
      startup?.abort();
      startup = undefined;
      stopPlugin(app, clock, state);
    },

    registerWithRouter(router: PluginRouter): void {
      registerRoutes(router, apiFor(app, clock, state), (message) => app.error(message));
    }
  };
};
