import type { LookaheadOptions } from "./engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "./engine/lookahead";
import type { VesselModel } from "./model/vessel";

/**
 * Plugin configuration: the JSON schema shown in the Signal K admin UI and
 * its parsing into typed options. Distances are metres, times seconds.
 */

export interface PluginConfig {
  /** Directory holding a built index (cells.json, pyramid.bin, hazards.json). */
  indexDir?: string;
  /** Directory of exported cells (one sub-directory per cell) to build from. */
  cellsDir?: string;
  /** Rebuild the index from cellsDir at start even when one exists. */
  rebuildIndex: boolean;
  /** Leaf zoom of the pyramid; z20 ≈ 19 m tiles at 60°N. */
  leafZoom: number;
  vessel: Partial<VesselModel>;
  lookahead: LookaheadOptions;
}

export const SCHEMA = {
  type: "object",
  description:
    "Advisory navigation aid. Not for navigation; does not replace official charts or a proper lookout.",
  properties: {
    indexDir: {
      type: "string",
      title: "Chart index directory",
      description: "Built index. Default: <plugin data dir>/index"
    },
    cellsDir: {
      type: "string",
      title: "Exported ENC cells directory",
      description: "One sub-directory per cell from scripts/enc-to-geojson.sh"
    },
    rebuildIndex: { type: "boolean", title: "Rebuild index at start", default: false },
    leafZoom: {
      type: "number",
      title: "Index leaf zoom",
      default: 20,
      minimum: 14,
      maximum: 22
    },
    vessel: {
      type: "object",
      title: "Vessel (overrides Signal K design.*)",
      properties: {
        draft: { type: "number", title: "Draft (m)" },
        length: { type: "number", title: "Length overall (m)" },
        beam: { type: "number", title: "Beam (m)" }
      }
    },
    lookahead: {
      type: "object",
      title: "Look-ahead",
      properties: {
        distance: { type: "number", title: "Look-ahead distance (m)", default: 555.6 },
        minHorizon: { type: "number", title: "Minimum horizon (s)", default: 60 },
        margin: { type: "number", title: "Safety margin under keel (m)", default: 0.5 },
        positionBuffer: { type: "number", title: "Position buffer (m)", default: 10 },
        warnWithin: { type: "number", title: "Warn when shoal within (s)", default: 120 },
        alarmWithin: { type: "number", title: "Alarm when shoal within (s)", default: 30 }
      }
    }
  }
} as const;

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function optionalPositive(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function parseConfig(raw: unknown): PluginConfig {
  const r = record(raw);
  const v = record(r.vessel);
  const l = record(r.lookahead);
  const d = DEFAULT_LOOKAHEAD;
  const lookahead: LookaheadOptions = {
    ...d,
    distance: num(l.distance, d.distance, 0),
    minHorizon: num(l.minHorizon, d.minHorizon, 0),
    margin: num(l.margin, d.margin, 0),
    positionBuffer: num(l.positionBuffer, d.positionBuffer, 0),
    warnWithin: num(l.warnWithin, d.warnWithin, 0),
    alarmWithin: num(l.alarmWithin, d.alarmWithin, 0)
  };
  // An alarm window wider than the warn window would skip warn entirely.
  lookahead.warnWithin = Math.max(lookahead.warnWithin, lookahead.alarmWithin);
  return {
    indexDir: str(r.indexDir),
    cellsDir: str(r.cellsDir),
    rebuildIndex: r.rebuildIndex === true,
    leafZoom: Math.round(num(r.leafZoom, 20, 14, 22)),
    vessel: {
      draft: optionalPositive(v.draft),
      length: optionalPositive(v.length),
      beam: optionalPositive(v.beam)
    },
    lookahead
  };
}
