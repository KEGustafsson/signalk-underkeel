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
import type { IndexPlan } from "./index-loader";
import { cellSources, planIndex, sourceKeys } from "./index-loader";
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
import {
  ALL_COLLECTIONS,
  noteSharedCells,
  runningProviders,
  sharedEncApi,
  watchSharedCells,
  withSharedCells
} from "./shared-enc";
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
 * Restarts the plugin once the shared ENC cells it reads changed: a start compares them with the
 * saved index and rebuilds it when they did. A server without a restart callback logs instead.
 */
function watchShared(
  app: ServerAPI,
  clock: Clock,
  collection: string,
  restart: (() => void) | undefined,
  sameCells: ((root: string) => boolean) | undefined
): SharedEncWatch {
  return watchSharedCells(
    collection,
    clock,
    () => {
      if (restart) {
        restart();
      } else {
        app.error("the shared ENC cells changed; restart the plugin to index them");
      }
    },
    sameCells ? { sameCells } : {}
  );
}

/** The stamps of the S-57 cells under `dir`, as one string; undefined when it cannot be read. */
function cellsStamp(dir: string): string | undefined {
  try {
    return sourceKeys(cellSources(dir)).join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Watches the charts provider's cells in use (`watchShared`). A provider publishing later the
 * cells read at start restarts nothing: the reason shown loses its note that it had not started.
 */
function watchAtStart(
  app: ServerAPI,
  clock: Clock,
  state: PluginState,
  plan: IndexPlan,
  restart: (() => void) | undefined
): SharedEncWatch | undefined {
  const { config, load } = state;
  const collection = config?.chartsProviderEnc;
  if (!config || collection === undefined) {
    return undefined;
  }
  const same = sameCellsAsStart(config.cellsDir, collection);
  const renote = (): void => {
    if ("load" in plan && state.load === load && load?.reason !== undefined) {
      const fresh = noteSharedCells(plan.load, config);
      state.load = fresh;
      if (!fresh.index && fresh.reason !== undefined) {
        state.monitor?.noIndex(fresh.reason);
      }
    }
  };
  const quiet =
    same &&
    ((root: string): boolean => {
      const unchanged = same(root);
      if (unchanged) {
        renote();
      }
      return unchanged;
    });
  return watchShared(app, clock, collection, restart, quiet);
}

/**
 * Whether a charts provider that publishes its store later than this plugin starts, as it does
 * once its charts are loaded, publishes the cells read at start: the same directory, the same
 * cells. Undefined when the provider was there at start, or nothing was read.
 */
function sameCellsAsStart(
  cellsDir: string | undefined,
  collection: string
): ((root: string) => boolean) | undefined {
  if (sharedEncApi() !== undefined || cellsDir === undefined) {
    return undefined;
  }
  const stamp = cellsStamp(cellsDir);
  if (stamp === undefined) {
    return undefined;
  }
  return (root) => {
    const dir = collection === ALL_COLLECTIONS ? root : path.join(root, collection);
    return path.resolve(dir) === path.resolve(cellsDir) && cellsStamp(dir) === stamp;
  };
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
  // The chart pulldown lists what Charts Provider shares also while this plugin is off.
  hints.enc ??= runningProviders();
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
      const load = "load" in plan ? noteSharedCells(plan.load, config) : pendingLoad(plan);
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
      shared = watchAtStart(app, clock, state, plan, restart && (() => restart(migration.config)));
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
