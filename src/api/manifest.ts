import type { ResourceProvider } from "@signalk/server-api";
import { API_BASE } from "./routes";

/**
 * Plotter Extensions manifest contribution (plan §4.14, §5). The plotter UI
 * is declared here rather than built into a plotter: the UKC tile overlay,
 * the look-ahead envelope and route-check legs as data overlays a
 * background runtime keeps current, a status widget, and the details and
 * setup panels with a toolbar button each. Their pages are served from
 * ASSET_BASE (see assets.ts).
 */

export const PLUGIN_ID = "signalk-underkeel";

/** Where the extension pages are served; outside /plugins, which needs an admin login. */
export const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;

interface IframeContribution {
  id: string;
  title: string;
  type: "iframe";
  url: string;
  lifecycle?: "onOpen" | "keepAlive" | "whileEnabled";
}

export interface Manifest {
  name: string;
  description: string;
  version: string;
  apiVersion: "1";
  requires: string[];
  optional: string[];
  overlays: {
    id: string;
    title: string;
    type: "data";
    band: "aboveCharts" | "aboveResources";
    visible: boolean;
    opacity: number;
    minZoom?: number;
    style: string;
  }[];
  background: IframeContribution[];
  widgets: (IframeContribution & { size: "1x1" | "2x1" | "1x2" | "2x2" })[];
  panels: IframeContribution[];
  buttons: {
    id: string;
    title: string;
    slot: "mapToolbar";
    icon: string;
    action: { type: "togglePanel"; panel: string };
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
          // A cell raised only by a nearby cell's chart position is drawn fainter
          // than one the chart itself classes so.
          "fill-opacity": [
            "case",
            ["==", ["get", "reach"], "1"],
            0.25,
            ["match", ["get", "class"], "clear", 0.25, 0.55]
          ]
        }
      }
    ]
  };
}

/** The pages a host shows: a background runtime, a status widget, two panels and their buttons. */
const UI: Pick<Manifest, "background" | "widgets" | "panels" | "buttons"> = {
  background: [
    {
      id: "live",
      title: "Look-ahead and route check",
      type: "iframe",
      url: `${ASSET_BASE}/runtime.html`
    }
  ],
  widgets: [
    {
      id: "status",
      title: "Under-keel status",
      type: "iframe",
      url: `${ASSET_BASE}/widget.html`,
      size: "2x1",
      lifecycle: "whileEnabled"
    }
  ],
  panels: [
    {
      id: "details",
      title: "Under-keel details",
      type: "iframe",
      url: `${ASSET_BASE}/panel.html`,
      lifecycle: "onOpen"
    },
    {
      id: "setup",
      title: "Under-keel setup",
      type: "iframe",
      url: `${ASSET_BASE}/setup.html`,
      lifecycle: "onOpen"
    }
  ],
  buttons: [
    {
      id: "open-details",
      title: "Under-keel details",
      slot: "mapToolbar",
      icon: "sailing",
      action: { type: "togglePanel", panel: "details" }
    },
    {
      id: "open-setup",
      title: "Under-keel setup",
      slot: "mapToolbar",
      icon: "tune",
      action: { type: "togglePanel", panel: "setup" }
    }
  ]
};

function overlays(): Manifest["overlays"] {
  return [
    {
      id: "ukc",
      title: "Under-keel risk",
      type: "data",
      band: "aboveCharts",
      visible: false,
      opacity: 0.6,
      minZoom: UKC_MIN_ZOOM,
      style: `${BASE}/ukc-style.json`
    },
    {
      id: "lookahead",
      title: "Under-keel look-ahead",
      type: "data",
      band: "aboveResources",
      visible: true,
      opacity: 0.8,
      style: `${ASSET_BASE}/lookahead-style.json`
    },
    {
      id: "routecheck",
      title: "Under-keel route check",
      type: "data",
      band: "aboveResources",
      visible: true,
      opacity: 0.9,
      style: `${ASSET_BASE}/routecheck-style.json`
    }
  ];
}

export function buildManifest(version: string): Record<string, Manifest> {
  return {
    [PLUGIN_ID]: {
      name: "Under-Keel Awareness",
      description:
        "Look-ahead grounding risk, route checks and a UKC overlay. Advisory: always use an official chart.",
      version,
      apiVersion: "1",
      requires: [],
      optional: [
        "overlays.data",
        "background.iframe",
        "widgets",
        "panels.iframe",
        "buttons",
        "signalk.stream",
        "routes",
        "units",
        "ui",
        "events.publish",
        "x-freeboard.services.navigationSafety"
      ],
      ...UI,
      overlays: overlays(),
      services: {
        navigationSafety: {
          apiVersion: "1",
          base: BASE,
          provides: ["lookahead", "routeCheck", "routeRepair", "departureWindow", "query", "acks"],
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
