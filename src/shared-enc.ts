import path from "path";
import type { PluginConfig } from "./config";
import type { Clock } from "./monitor";

/**
 * ENC cells shared by signalk-charts-provider-simple. Its ENC store keeps the
 * cells behind its ENC charts as delivered, one folder per collection (an
 * ENC Charts set's cells, or a converted chart's):
 * `<root>/<collection>/<CELL>/<CELL>.000` with the updates beside it. The
 * plugin reads a collection, or the whole store, as its cells directory,
 * and is told when the cells change. See that plugin's docs/enc-store.md.
 */

export const CHARTS_PROVIDER_ID = "signalk-charts-provider-simple";
/** Every collection the charts provider shares. */
export const ALL_COLLECTIONS = "*";
const COLLECTION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface SharedEncCollection {
  id: string;
  name: string;
  kind: string;
  cellCount: number;
}

/** The part of the charts provider's `globalThis.__signalk_chartsProviderEnc` used here. */
export interface SharedEncApi {
  apiVersion: number;
  root: string;
  collections: () => SharedEncCollection[];
  onChange: (listener: (collectionId: string) => void) => () => void;
}

/** A collection's id, or ALL_COLLECTIONS. */
export function isCollectionChoice(value: string): boolean {
  return value === ALL_COLLECTIONS || COLLECTION_ID.test(value);
}

/** The charts provider's ENC store API, while that plugin runs in this server. */
export function sharedEncApi(scope: object = globalThis): SharedEncApi | undefined {
  const api = (scope as { __signalk_chartsProviderEnc?: unknown }).__signalk_chartsProviderEnc;
  if (typeof api !== "object" || api === null) {
    return undefined;
  }
  const a = api as Partial<SharedEncApi>;
  return a.apiVersion === 1 &&
    typeof a.root === "string" &&
    typeof a.collections === "function" &&
    typeof a.onChange === "function"
    ? (a as SharedEncApi)
    : undefined;
}

/**
 * The charts provider's ENC store: where its API says, else where that plugin keeps it,
 * beside this plugin's data directory, so the cells are found while it is still starting.
 */
export function sharedEncRoot(dataDir: string, api = sharedEncApi()): string {
  return api?.root ?? path.join(path.dirname(dataDir), CHARTS_PROVIDER_ID, "enc-store");
}

/** The directory of a collection's cells; the whole store for ALL_COLLECTIONS. */
export function sharedCellsDir(dataDir: string, collection: string, api = sharedEncApi()): string {
  const root = sharedEncRoot(dataDir, api);
  return collection === ALL_COLLECTIONS ? root : path.join(root, collection);
}

/** `cfg` reading its cells from the charts provider's collection when it names one. */
export function withSharedCells(
  cfg: PluginConfig,
  dataDir: string,
  api = sharedEncApi()
): PluginConfig {
  return cfg.chartsProviderEnc === undefined
    ? cfg
    : { ...cfg, cellsDir: sharedCellsDir(dataDir, cfg.chartsProviderEnc, api) };
}

/** One line naming the collections the charts provider shares, for the admin form. */
export function collectionsHint(api = sharedEncApi()): string | undefined {
  if (!api) {
    return undefined;
  }
  let collections: SharedEncCollection[];
  try {
    collections = api.collections();
  } catch {
    return undefined;
  }
  return collections.length === 0
    ? "Charts Provider shares no ENC cells yet: download an ENC Charts set there."
    : `Shared now: ${collections
        .map(
          (c) =>
            `${c.id} (${c.kind === "chart-set" ? "chart set" : "converted chart"}, ${c.cellCount} cells)`
        )
        .join(", ")}.`;
}

export interface SharedEncWatchOptions {
  /** A change is acted on once no other came for this long, ms: a chart set writes twice. */
  settleMs?: number;
  /** How long to wait for the charts provider to start, ms. */
  waitMs?: number;
  /** How often to look for it meanwhile, and for a settled change, ms. */
  pollMs?: number;
  scope?: object;
  /**
   * The store root the cells were read from at start. An API that appears later with
   * another root counts as a change, so the cells are read from where it says.
   */
  startedRoot?: string;
}

export interface SharedEncWatch {
  stop(): void;
}

/**
 * Calls `onChange` once the cells of `collection` (any, for ALL_COLLECTIONS) changed and
 * settled. Waits up to `waitMs` for the charts provider to publish its API when it has not
 * yet; without it nothing is watched, and the cells are read as found at start.
 */
export function watchSharedCells(
  collection: string,
  clock: Clock,
  onChange: () => void,
  opts: SharedEncWatchOptions = {}
): SharedEncWatch {
  const settleMs = opts.settleMs ?? 5_000;
  const waitMs = opts.waitMs ?? 120_000;
  const pollMs = opts.pollMs ?? 5_000;
  const started = clock.now();
  let unsubscribe: (() => void) | undefined;
  let changedAt: number | undefined;
  let timer: unknown;
  let stopped = false;
  const stopTimer = (): void => {
    if (timer !== undefined) {
      clock.clearInterval(timer);
      timer = undefined;
    }
  };
  const subscribe = (): boolean => {
    const api = sharedEncApi(opts.scope);
    if (!api) {
      return false;
    }
    const changed = (): void => {
      changedAt = clock.now();
      timer ??= clock.setInterval(tick, pollMs);
    };
    unsubscribe = api.onChange((id) => {
      if (collection === ALL_COLLECTIONS || id === collection) {
        changed();
      }
    });
    if (
      opts.startedRoot !== undefined &&
      path.resolve(api.root) !== path.resolve(opts.startedRoot)
    ) {
      changed();
    }
    return true;
  };
  function tick(): void {
    if (stopped) {
      return;
    }
    if (!unsubscribe && !subscribe() && clock.now() - started >= waitMs) {
      stopTimer();
      return;
    }
    if (changedAt !== undefined && clock.now() - changedAt >= settleMs) {
      changedAt = undefined;
      stopTimer();
      onChange();
      return;
    }
    if (unsubscribe && changedAt === undefined) {
      stopTimer();
    }
  }
  if (!subscribe()) {
    timer = clock.setInterval(tick, pollMs);
  }
  return {
    stop(): void {
      stopped = true;
      stopTimer();
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
