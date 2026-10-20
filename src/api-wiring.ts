import type { ServerAPI } from "@signalk/server-api";
import type { AckStore } from "./ack-store";
import type { AckServiceDeps } from "./ack-service";
import { addAck, deleteAck, listAcks } from "./ack-service";
import { ukcStyle } from "./api/manifest";
import type { ApiProvider, ApiReply } from "./api/routes";
import { UkcTileChanges } from "./api/ukc-tile-changes";
import type { PluginConfig } from "./config";
import { parseConfig } from "./config";
import type { EngineStatus } from "./foundation/state";
import type { IndexLoad } from "./index-loader";
import type { Clock, Monitor } from "./monitor";
import { CHART_DATUM } from "./model/water-level";
import type { QueryServiceDeps } from "./query-service";
import { query, ukcTileChangesReply, ukcTileReply } from "./query-service";
import type { RouteServiceDeps } from "./route-service";
import { departureWindowReply, routeCheck, routeRepair } from "./route-service";
import { statusReport } from "./status-report";
import type { LivechartService } from "./livechart-service";
import type { WfsService } from "./wfs-service";

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
}

const NOT_STARTED: ApiReply = { status: 503, body: { errors: ["plugin not started"] } };

export function apiFor(
  app: Pick<ServerAPI, "resourcesApi" | "error">,
  clock: Clock,
  s: PluginState
): ApiProvider {
  const tileChanges = new UkcTileChanges();
  const queryDeps = (): QueryServiceDeps => ({
    index: s.load?.index,
    indexReason: s.load?.reason ?? "plugin not started",
    config: s.config ?? parseConfig({}),
    vessel: () => s.monitor?.vessel(),
    waterLevel: () => s.monitor?.waterLevel() ?? CHART_DATUM,
    waveHeight: () => s.monitor?.nav.waveHeight?.value,
    tileChanges
  });
  const routeDeps = (): RouteServiceDeps => ({
    index: s.load?.index,
    indexReason: s.load?.reason ?? "plugin not started",
    config: s.config ?? parseConfig({}),
    vessel: () => s.monitor?.vessel(),
    waterLevel: (start, end, at) => s.monitor?.waterLevelOver(start, end, at) ?? CHART_DATUM,
    waveHeight: () => s.monitor?.nav.waveHeight?.value,
    getRoute: (id) => app.resourcesApi.getResource("routes", id),
    now: () => clock.now()
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
    status: () =>
      statusReport({
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
    routeCheck: (body) => routeCheck(body, routeDeps()),
    routeRepair: (body) => routeRepair(body, routeDeps()),
    departureWindow: (body) => departureWindowReply(body, routeDeps()),
    query: (body) => query(body, queryDeps()),
    ukcTile: (z, x, y) => ukcTileReply(z, x, y, queryDeps()),
    ukcTileChanges: (q) => ukcTileChangesReply(q, queryDeps()),
    ukcStyle,
    acks: () => withAcks(listAcks),
    addAck: (body) => withAcks((deps) => addAck(body, deps)),
    deleteAck: (id) => withAcks((deps) => deleteAck(id, deps)),
    discrepancies: () =>
      s.livechart
        ? { status: 200, body: s.livechart.discrepancies() }
        : { status: 404, body: { errors: ["living chart is off"] } },
    csb: () =>
      s.livechart
        ? { status: 200, body: s.livechart.csb() }
        : { status: 404, body: { errors: ["living chart is off"] } }
  };
}
