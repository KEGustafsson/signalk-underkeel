import type { ResourceProvider } from "@signalk/server-api";
import { API_BASE } from "./routes";

/**
 * Plotter Extensions manifest contribution (plan §4.14). Only the parts
 * that exist are declared: the experimental `services.navigationSafety`
 * section lists what this build serves. The UKC overlay and the settings
 * panel are added when their endpoints exist.
 */

export const PLUGIN_ID = "signalk-underkeel";

export interface Manifest {
  name: string;
  version: string;
  apiVersion: "1";
  requires: string[];
  optional: string[];
  services: {
    navigationSafety: {
      apiVersion: "1";
      base: string;
      provides: string[];
      statePath: string;
      notificationPath: string;
    };
  };
}

export function buildManifest(version: string): Record<string, Manifest> {
  return {
    [PLUGIN_ID]: {
      name: "Under-Keel Awareness",
      version,
      apiVersion: "1",
      requires: [],
      optional: ["x-freeboard.services.navigationSafety"],
      services: {
        navigationSafety: {
          apiVersion: "1",
          base: `/plugins/${PLUGIN_ID}${API_BASE}`,
          provides: ["lookahead", "routeCheck"],
          statePath: "navigation.underKeel",
          notificationPath: "notifications.navigation.underKeel"
        }
      }
    }
  };
}

/** Read-only resource provider serving the manifest as `plotterExtensions` resources. */
export function manifestProvider(version: string): ResourceProvider {
  const manifest = buildManifest(version);
  const readOnly = (): Promise<void> =>
    Promise.reject(new Error("plotterExtensions resources are read-only"));
  return {
    type: "plotterExtensions",
    methods: {
      listResources: () => Promise.resolve(manifest),
      getResource: (id: string) => {
        const m = manifest[id];
        return m
          ? Promise.resolve(m as unknown as object)
          : Promise.reject(new Error(`no plotterExtensions resource ${id}`));
      },
      setResource: readOnly,
      deleteResource: readOnly
    }
  };
}
