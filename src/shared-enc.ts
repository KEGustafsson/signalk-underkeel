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
/** A collection choice for the admin form, with the space around it that parsing trims. */
export const COLLECTION_CHOICE_PATTERN = "^\\s*(\\*|[A-Za-z0-9_-]{1,80})?\\s*$";

export interface SharedEncCollection {
  id: string;
  name: string;
  kind: string;
  cellCount: number;
}

export interface SharedAreaAnswer {
  accepted: boolean;
  started: boolean;
  reason: string;
}

/**
 * The part of the charts provider's `globalThis.__signalk_chartsProviderEnc` used here.
 * `state` and `requestArea` came after the API's first release: an older charts provider
 * lacks them.
 */
export interface SharedEncApi {
  apiVersion: number;
  root: string;
  collections: () => SharedEncCollection[];
  onChange: (listener: (collectionId: string) => void) => () => void;
  state?: (id: string) => { state: string; detail?: string };
  requestArea?: (
    bbox: readonly [number, number, number, number],
    requester: string
  ) => SharedAreaAnswer;
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

/**
 * Why the charts provider's `collection` holds no cells to read, as it tells it; undefined
 * when it is ready, or the provider cannot tell.
 */
export function sharedCellsNote(collection: string, api = sharedEncApi()): string | undefined {
  if (!api) {
    return undefined;
  }
  if (collection === ALL_COLLECTIONS) {
    return collectionsHint(api)?.startsWith("Charts Provider shares no")
      ? "Charts Provider shares no ENC cells yet: download an ENC Charts set there"
      : undefined;
  }
  let found: { state: string; detail?: string } | undefined;
  try {
    found = api.state?.(collection);
  } catch {
    return undefined;
  }
  switch (found?.state) {
    case "writing":
      return `Charts Provider is writing the cells of ${collection}; the index is built once they are in place`;
    case "pending":
      return found.detail === "downloading"
        ? `Charts Provider is downloading ${collection}; the index is built once its cells are shared`
        : `${collection} is a Charts Provider chart set not downloaded yet: download it in its ENC Charts tab`;
    case "absent":
      return `Charts Provider shares no ${collection}: check ENC from Charts Provider`;
    default:
      return undefined;
  }
}

/** `load` with the charts provider's word on why the collection in use has no cells. */
export function noteSharedCells<T extends { reason?: string }>(
  load: T,
  cfg: Pick<PluginConfig, "chartsProviderEnc">,
  api = sharedEncApi()
): T {
  const note =
    load.reason !== undefined && cfg.chartsProviderEnc !== undefined
      ? sharedCellsNote(cfg.chartsProviderEnc, api)
      : undefined;
  return note === undefined ? load : { ...load, reason: `${load.reason ?? ""}; ${note}` };
}

/** Asks the charts provider for the cells around `bbox`; undefined when it cannot be asked. */
export function requestSharedArea(
  bbox: readonly [number, number, number, number],
  api = sharedEncApi()
): SharedAreaAnswer | undefined {
  try {
    return api?.requestArea?.(bbox, "signalk-underkeel");
  } catch (err) {
    return { accepted: false, started: false, reason: (err as Error).message };
  }
}

export interface SharedEncWatchOptions {
  /** A change is acted on once no other came for this long, ms: a chart set writes twice. */
  settleMs?: number;
  /** How long to look for the charts provider every `pollMs` when it has not started, ms. */
  waitMs?: number;
  /** How often to look for it meanwhile, and for a settled change, ms. */
  pollMs?: number;
  /** How often to look for it after `waitMs`, ms. */
  slowPollMs?: number;
  scope?: object;
}

export interface SharedEncWatch {
  stop(): void;
}

/**
 * Calls `onChange` once the cells of `collection` (any, for ALL_COLLECTIONS) changed and
 * settled. While the charts provider has not published its API, looks for it every `pollMs`,
 * and after `waitMs` every `slowPollMs` for as long as the watch runs, since it may start any
 * time; meanwhile the cells are read as found at start. An API that appears later counts as
 * a change: the provider may have written cells meanwhile, or keep its store elsewhere than
 * the default path the cells were read from, and the restart rebuilds the index only when
 * the cells it finds differ.
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
  const slowPollMs = opts.slowPollMs ?? 60_000;
  const started = clock.now();
  let unsubscribe: (() => void) | undefined;
  let changedAt: number | undefined;
  let timer: unknown;
  let stopped = false;
  let slow = false;
  const stopTimer = (): void => {
    if (timer !== undefined) {
      clock.clearInterval(timer);
      timer = undefined;
    }
  };
  const changed = (): void => {
    changedAt = clock.now();
    timer ??= clock.setInterval(tick, pollMs);
  };
  const subscribe = (late: boolean): boolean => {
    const api = sharedEncApi(opts.scope);
    if (!api) {
      return false;
    }
    unsubscribe = api.onChange((id) => {
      if (collection === ALL_COLLECTIONS || id === collection) {
        changed();
      }
    });
    if (late) {
      stopTimer();
      changed();
    }
    return true;
  };
  function tick(): void {
    if (stopped) {
      return;
    }
    if (!unsubscribe && !subscribe(true)) {
      if (!slow && clock.now() - started >= waitMs) {
        slow = true;
        stopTimer();
        timer = clock.setInterval(tick, slowPollMs);
      }
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
  if (!subscribe(false)) {
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
