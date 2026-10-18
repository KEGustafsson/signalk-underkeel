import type { ResourceProvider } from "@signalk/server-api";
import { API_BASE } from "./routes";

/**
 * Plotter Extensions manifest contribution (plan §4.14). Only the parts
 * that exist are declared: the UKC data overlay and the experimental
 * `services.navigationSafety` section listing what this build serves. The
 * settings panel is added when its page exists.
 */

export const PLUGIN_ID = "signalk-underkeel";

export interface Manifest {
  name: string;
  version: string;
  apiVersion: "1";
  requires: string[];
  optional: string[];
  overlays: {
    id: string;
    title: string;
    type: "data";
    band: "aboveCharts";
    visible: boolean;
    opacity: number;
    minZoom: number;
    style: string;
  }[];
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

const BASE = `/plugins/${PLUGIN_ID}${API_BASE}`;

/** Zoom below which the UKC tiles are empty. */
export const UKC_MIN_ZOOM = 11;

/** Fill colour per UKC class; land is left to the chart. */
const UKC_COLOURS = {
  danger: "#d7301f",
  caution: "#fdae61",
  unverified: "#9e9ac8",
  clear: "#41ab5d"
} as const;

/** MapLibre style for the UKC overlay tiles. */
export function ukcStyle(): Record<string, unknown> {
  return {
    version: 8,
    name: "Under-keel risk",
    sources: {
      ukc: {
        type: "vector",
        tiles: [`${BASE}/tiles/ukc/{z}/{x}/{y}.pbf`],
        minzoom: UKC_MIN_ZOOM,
        maxzoom: 18
      }
    },
    layers: [
      {
        id: "ukc-fill",
        type: "fill",
        source: "ukc",
        "source-layer": "ukc",
        filter: ["!=", ["get", "class"], "land"],
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            ...Object.entries(UKC_COLOURS).flat(),
            "#000000"
          ],
          "fill-opacity": ["match", ["get", "class"], "clear", 0.25, 0.55]
        }
      }
    ]
  };
}

export function buildManifest(version: string): Record<string, Manifest> {
  return {
    [PLUGIN_ID]: {
      name: "Under-Keel Awareness",
      version,
      apiVersion: "1",
      requires: [],
      optional: ["overlays.data", "x-freeboard.services.navigationSafety"],
      overlays: [
        {
          id: "ukc",
          title: "Under-keel risk",
          type: "data",
          band: "aboveCharts",
          visible: false,
          opacity: 0.6,
          minZoom: UKC_MIN_ZOOM,
          style: `${BASE}/ukc-style.json`
        }
      ],
      services: {
        navigationSafety: {
          apiVersion: "1",
          base: BASE,
          provides: ["lookahead", "routeCheck", "query"],
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
