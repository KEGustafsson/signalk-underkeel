import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "./api-wiring";
import type { PluginConfig } from "./config";
import type { BuildPlan, IndexLoad, IndexPlan, ReadPlan } from "./index-loader";
import { BUILDING_REASON, builtLoad, failedLoad, LOADING_REASON, savedLoad } from "./index-loader";
import { startLivechart } from "./livechart-service";
import type { Clock, Monitor } from "./monitor";
import { loadChartIndexAsync } from "./spatial/chart-index";
import type { IndexBuilder, WfsService } from "./wfs-service";

/**
 * The chart index at start, when it must be built or a large one read: the
 * work runs off the event loop while the look-ahead is `off` with the reason,
 * then the index is handed to the running services.
 */

export interface Startup {
  app: ServerAPI;
  clock: Clock;
  state: PluginState;
  config: PluginConfig;
  monitor: Monitor;
  wfs: WfsService | undefined;
}

/** The load the plugin starts with while `plan` runs. */
export function pendingLoad(plan: BuildPlan | ReadPlan): IndexLoad {
  return "build" in plan
    ? { indexDir: plan.indexDir, built: false, reason: BUILDING_REASON }
    : { indexDir: plan.read, built: false, reason: LOADING_REASON };
}

function handOver(s: Startup, load: IndexLoad): void {
  s.state.load = load;
  if (load.index) {
    s.monitor.setIndex(load.index);
    s.state.livechart = startLivechart(s.app, s.clock, s.config, load.index, s.monitor);
  } else {
    s.monitor.noIndex(load.reason ?? "no chart index loaded");
  }
  // The WFS box starts only now, so a box rebuilt meanwhile is never replaced by this index.
  s.wfs?.start();
}

/** Runs `plan` and hands its index over; abort it on stop(). */
export function settleAtStart(
  s: Startup,
  plan: BuildPlan | ReadPlan,
  build: IndexBuilder
): AbortController {
  const controller = new AbortController();
  const current = (): boolean => !controller.signal.aborted && s.state.monitor === s.monitor;
  const run = (p: IndexPlan): Promise<IndexLoad> => {
    if ("load" in p) {
      return Promise.resolve(p.load);
    }
    if ("build" in p) {
      return build(p.build, controller.signal).then(
        (index) => builtLoad(p, index),
        (err) => failedLoad(p.indexDir, err)
      );
    }
    return loadChartIndexAsync(p.read).then(
      (index) => savedLoad(p, index),
      (err) => {
        const next = p.unreadable(err);
        if ("build" in next && current()) {
          s.state.load = pendingLoad(next);
          s.monitor.noIndex(BUILDING_REASON);
        }
        return run(next);
      }
    );
  };
  void run(plan).then((load) => {
    if (current()) {
      handOver(s, load);
    }
  });
  return controller;
}
