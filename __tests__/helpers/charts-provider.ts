import type { SharedAreaAnswer, SharedEncApi } from "../../src/shared-enc";
import { CHARTS_PROVIDER_ID } from "../../src/shared-enc";

/**
 * A stand-in for signalk-charts-provider-simple, the only ENC source the plugin reads: its API
 * on `globalThis` with its ENC store at a test's cells directory. Removed after each test.
 */

type Scope = { __signalk_chartsProviderEnc?: unknown };

export interface FakeChartsProvider {
  api: SharedEncApi;
  /** Tells the plugin the cells of `collection` changed, as the provider does. */
  emit: (collection: string) => void;
}

/**
 * Runs a charts provider whose store is `root` and returns the setting that chooses it, to
 * spread into a plugin's options. `answer` is what it says when asked for an area's cells.
 */
export function chartsProviderAt(
  root: string,
  answer?: (bbox: readonly [number, number, number, number]) => SharedAreaAnswer
): { chartsProvider: string } {
  installChartsProvider(root, answer);
  return { chartsProvider: CHARTS_PROVIDER_ID };
}

export function installChartsProvider(
  root: string,
  answer?: (bbox: readonly [number, number, number, number]) => SharedAreaAnswer
): FakeChartsProvider {
  const listeners = new Set<(id: string) => void>();
  const api: SharedEncApi = {
    apiVersion: 1,
    root,
    collections: () => [{ id: "Test_Set", name: "Test set", kind: "chart-set", cellCount: 2 }],
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...(answer ? { requestArea: answer } : {})
  };
  (globalThis as Scope).__signalk_chartsProviderEnc = api;
  return { api, emit: (id) => [...listeners].forEach((l) => l(id)) };
}

afterEach(() => {
  delete (globalThis as Scope).__signalk_chartsProviderEnc;
});
