import type { Path, Plugin, PluginRouter, ServerAPI } from "@signalk/server-api";
import { registerStatusRoute } from "./api/status";
import { createStatus, EngineStatus, PATHS } from "./foundation/state";

const PLUGIN_ID = "signalk-underkeel";

export = function underkeel(app: ServerAPI): Plugin {
  let status: EngineStatus = createStatus("off", "plugin not started", new Date());

  function publishState(next: EngineStatus): void {
    status = next;
    app.handleMessage(PLUGIN_ID, {
      updates: [{ values: [{ path: PATHS.state as Path, value: next.state }] }]
    });
  }

  return {
    id: PLUGIN_ID,
    name: "Under-Keel Awareness",
    description: "Look-ahead grounding risk, route checks and a living chart (advisory only).",

    schema: {
      type: "object",
      properties: {}
    },

    start(): void {
      // The risk engine does not exist yet (docs/DEVELOPMENT-PLAN.md, M1).
      // Publishing "off" with a reason keeps the never-silent rule from day one.
      publishState(createStatus("off", "risk engine not implemented", new Date()));
      app.setPluginStatus("Started — risk engine not implemented, monitoring OFF");
    },

    stop(): void {
      status = createStatus("off", "plugin stopped", new Date());
    },

    registerWithRouter(router: PluginRouter): void {
      registerStatusRoute(router, () => status);
    }
  };
};
