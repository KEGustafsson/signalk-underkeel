import type { ServerAPI } from "@signalk/server-api";
import type { AckStore } from "./ack-store";
import type { AckServiceDeps } from "./ack-service";
import { addAck, deleteAck, listAcks } from "./ack-service";
import { ukcStyle } from "./api/manifest";
import type { ApiProvider, ApiReply } from "./api/routes";
import type { PluginConfig } from "./config";
import { parseConfig } from "./config";
import type { EngineStatus } from "./foundation/state";
import type { IndexLoad } from "./index-loader";
import type { Clock, Monitor } from "./monitor";
import { CHART_DATUM } from "./model/water-level";
import type { QueryServiceDeps } from "./query-service";
import { query, ukcTileReply } from "./query-service";
import { routeCheck } from "./route-service";
import { statusReport } from "./status-report";

/** The REST handlers bound to the plugin's current state (plan §4.10). */

export interface PluginState {
  monitor?: Monitor;
  load?: IndexLoad;
  config?: PluginConfig;
  acks?: AckStore;
  zoneErrors: string[];
  stopped: EngineStatus;
}

const NOT_STARTED: ApiReply = { status: 503, body: { errors: ["plugin not started"] } };

export function apiFor(
  app: Pick<ServerAPI, "resourcesApi">,
  clock: Clock,
  s: PluginState
): ApiProvider {
  const queryDeps = (): QueryServiceDeps => ({
    index: s.load?.index,
    indexReason: s.load?.reason ?? "plugin not started",
    config: s.config ?? parseConfig({}),
    vessel: () => s.monitor?.vessel(),
    waterLevel: () => s.monitor?.waterLevel() ?? CHART_DATUM,
    waveHeight: () => s.monitor?.nav.waveHeight?.value
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
      waterLevel: () => m.waterLevel().h,
      draft: () => m.vessel()?.draft,
      now: () => clock.now()
    });
  };
  return {
    status: () =>
      statusReport({
        load: s.load,
        monitor: s.monitor,
        stopped: s.stopped,
        now: clock.now(),
        zoneErrors: s.zoneErrors
      }),
    envelope: () =>
      s.monitor
        ? { rev: s.monitor.envelope.rev, envelope: s.monitor.envelope.envelope }
        : { rev: 0, envelope: { type: "FeatureCollection", features: [] } },
    routeCheck: (body) =>
      routeCheck(body, {
        index: s.load?.index,
        indexReason: s.load?.reason ?? "plugin not started",
        config: s.config ?? parseConfig({}),
        vessel: () => s.monitor?.vessel(),
        waterLevel: (start, end) => s.monitor?.waterLevelOver(start, end) ?? CHART_DATUM,
        waveHeight: () => s.monitor?.nav.waveHeight?.value,
        getRoute: (id) => app.resourcesApi.getResource("routes", id),
        now: () => clock.now()
      }),
    query: (body) => query(body, queryDeps()),
    ukcTile: (z, x, y) => ukcTileReply(z, x, y, queryDeps()),
    ukcStyle,
    acks: () => withAcks(listAcks),
    addAck: (body) => withAcks((deps) => addAck(body, deps)),
    deleteAck: (id) => withAcks((deps) => deleteAck(id, deps))
  };
}
