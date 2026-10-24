import type { ServerAPI } from "@signalk/server-api";
import type { AckStore } from "./ack-store";
import type { AckServiceDeps } from "./ack-service";
import { addAck, deleteAck, listAcks } from "./ack-service";
import { ukcStyle } from "./api/manifest";
import type { ApiProvider, ApiReply } from "./api/routes";
import { UkcTileChanges } from "./api/ukc-tile-changes";
import { UkcTileCache } from "./engine/ukc-tile-geometry";
import type { PluginConfig } from "./config";
import { parseConfig } from "./config";
import type { EngineStatus } from "./foundation/state";
import type { IndexLoad } from "./index-loader";
import type { Clock, Monitor } from "./monitor";
import { CHART_DATUM } from "./model/water-level";
import type { QueryServiceDeps } from "./query-service";
import { query, ukcTileChangesReply, ukcTileReply } from "./query-service";
import type { RouteServiceDeps } from "./route-service";
import type { RequestQueue } from "./route-service";
import { departureWindowReply, routeCheck, routeRepair } from "./route-service";
import { statusReport } from "./status-report";
import type { LivechartService } from "./livechart-service";
import type { WfsService } from "./wfs-service";
import { saveSettings, settingsReply } from "./settings-service";

/** The REST handlers bound to the plugin's current state (plan §4.10). */

export interface PluginState {
  monitor?: Monitor;
  load?: IndexLoad;
  config?: PluginConfig;
  acks?: AckStore;
  zoneErrors: string[];
  livechart?: LivechartService;
  wfs?: WfsService;
  stopped: EngineStatus;
  /** The heavy REST work, aborted when the plugin stops. */
  requests: RequestQueue;
  /** The saved configuration as started, migrated to the current version. */
  options?: Record<string, unknown>;
  /** The server's callback that saves a configuration and restarts the plugin with it. */
  restart?: (config: object) => void;
}

const NOT_STARTED: ApiReply = { status: 503, body: { errors: ["plugin not started"] } };

function livechartReply(s: PluginState, body: (l: LivechartService) => unknown): ApiReply {
  return s.livechart
    ? { status: 200, body: body(s.livechart) }
    : { status: 404, body: { errors: ["living chart is off"] } };
}

export function apiFor(
  app: Pick<ServerAPI, "resourcesApi" | "error" | "getSelfPath">,
  clock: Clock,
  s: PluginState
): ApiProvider {
  const tileChanges = new UkcTileChanges();
  const tileCache = new UkcTileCache();
  const queryDeps = (): QueryServiceDeps => ({
    index: s.load?.index,
    indexReason: s.load?.reason ?? "plugin not started",
    config: s.config ?? parseConfig({}),
    vessel: () => s.monitor?.vessel(),
    levelRegimes: () => s.monitor?.levelRegimes() ?? { inside: CHART_DATUM },
    waveHeight: () => s.monitor?.nav.waveHeight?.value,
    tileChanges,
    tileCache
  });
  const routeDeps = (): RouteServiceDeps => ({
    index: s.load?.index,
    indexReason: s.load?.reason ?? "plugin not started",
    config: s.config ?? parseConfig({}),
    vessel: () => s.monitor?.vessel(),
    waterLevel: (start, end, at) => s.monitor?.waterLevelOver(start, end, at) ?? CHART_DATUM,
    waveHeight: () => s.monitor?.nav.waveHeight?.value,
    getRoute: (id) => app.resourcesApi.getResource("routes", id),
    now: () => clock.now(),
    queue: s.requests
  });
  const withAcks = (fn: (deps: AckServiceDeps) => ApiReply): ApiReply => {
    const m = s.monitor;
    if (!s.acks || !m) {
      return NOT_STARTED;
    }
    return fn({
      store: s.acks,
      current: () => m.last,
      heading: () => m.heading(),
      waterLevel: () => m.waterLevel(),
      draft: () => m.vessel()?.draft,
      now: () => clock.now(),
      error: (message) => app.error(message)
    });
  };
  return {
    status: (summary) =>
      statusReport({
        summary,
        load: s.load,
        monitor: s.monitor,
        stopped: s.stopped,
        now: clock.now(),
        zoneErrors: s.zoneErrors,
        livechart: s.livechart,
        wfs: s.wfs
      }),
    envelope: () =>
      s.monitor
        ? { rev: s.monitor.envelope.rev, envelope: s.monitor.envelope.envelope }
        : { rev: 0, envelope: { type: "FeatureCollection", features: [] } },
    routeCheck: (body, signal) => routeCheck(body, routeDeps(), signal),
    routeRepair: (body, signal) => routeRepair(body, routeDeps(), signal),
    departureWindow: (body, signal) => departureWindowReply(body, routeDeps(), signal),
    query: (body, signal) => query(body, queryDeps(), s.requests, signal),
    ukcTile: (z, x, y) => ukcTileReply(z, x, y, queryDeps()),
    ukcTileChanges: (q) => ukcTileChangesReply(q, queryDeps()),
    ukcStyle,
    acks: () => withAcks(listAcks),
    addAck: (body) => withAcks((deps) => addAck(body, deps)),
    deleteAck: (id) => withAcks((deps) => deleteAck(id, deps)),
    discrepancies: () => livechartReply(s, (l) => l.discrepancies()),
    csb: () => livechartReply(s, (l) => l.csb()),
    settings: () => settingsReply(app, s),
    saveSettings: (body) => saveSettings(body, s)
  };
}
