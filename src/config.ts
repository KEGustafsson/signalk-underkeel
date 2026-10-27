import type { GroundingOptions } from "./engine/grounding-detect";
import { DEFAULT_GROUNDING } from "./engine/grounding-detect";
import type { LookaheadOptions } from "./engine/lookahead";
import type { LivechartConfig } from "./livechart-service";
import { DEFAULT_LOOKAHEAD, LOOKAHEAD_LIMITS } from "./engine/lookahead";
import type { HeelModel } from "./model/allowances";
import type { DatumMapping } from "./ingest/datum";
import { DEFAULT_DATUMS } from "./ingest/datum";
import type { DynamicsOptions, VesselModel } from "./model/vessel";
import { DEFAULT_DYNAMICS } from "./model/vessel";
import { LIMITS } from "./api/route-request";
import { DEFAULT_WFS_URL, WFS_LIMITS } from "./ingest/wfs";
import type { WarningStyle } from "./config-presets";
import { WARNING_PRESETS, warningStyle } from "./config-presets";
import { MAX_BOX_KM } from "./box-sizing";

export { SCHEMA } from "./config-schema";

/**
 * Plugin configuration parsed into typed options. Out-of-range or
 * malformed values fall back to the defaults. Distances are metres, times
 * seconds, angles in the configuration degrees.
 */

export interface PluginConfig {
  /** Directory holding a built index (cells.json, pyramid.bin, hazards.bin). */
  indexDir?: string;
  /** Directory of S-57 cells (`.000` with updates, also in sub-folders) to build from. */
  cellsDir?: string;
  /** Rebuild the index from cellsDir at start even when one exists. */
  rebuildIndex: boolean;
  /** Leaf zoom of the pyramid; z20 ≈ 19 m tiles at 60°N. */
  leafZoom: number;
  /**
   * Half-width of the box around the vessel the index is built in, km; rebuilt as the
   * vessel moves. 0 builds every cell. With the Traficom WFS on, its radius is used.
   */
  boxRadiusKm: number;
  /**
   * Largest half-width the box grows to at speed, km, never below the box's own radius; 0
   * sizes it from the RAM (`autoCapKm`).
   */
  boxMaxRadiusKm: number;
  /** Sets the look-ahead fields the configuration leaves empty. */
  warningStyle: WarningStyle;
  vessel: Partial<VesselModel>;
  dynamics: DynamicsOptions;
  waterLevel: WaterLevelConfig;
  lookahead: LookaheadOptions;
  /** Undefined when the living chart is off. */
  livechart?: LivechartConfig;
  /** Signal K region ids treated as mooring zones. */
  mooringZones: string[];
  /** Undefined when the detector is off. */
  groundingDetector?: GroundingOptions;
  /** Undefined when the Traficom WFS depth source is off. */
  wfs?: WfsConfig;
  routeCheck: {
    /** Planning speed when a request gives none, m/s. */
    speed: number;
    /** Cross-track limit when a request gives none, metres. */
    xteLimit: number;
    /** A leg passes when P(UKC < 0) is below this. */
    probability: number;
  };
}

export interface WfsConfig {
  url: string;
  /** Half-width of the box downloaded around the vessel, km. */
  radiusKm: number;
  /** CATZOC assumed for WFS depths, 1–6; the WFS states none. */
  catzoc: number;
}

export interface WaterLevelConfig {
  source: "none" | "manual" | "signalk-tide" | "fmi";
  /** Manual height above chart datum, metres. */
  height: number;
  /** σ of the manual or Signal K tide height, metres. */
  sigma: number;
  /** FMI refresh interval, seconds. */
  updateInterval: number;
  /** Defaults followed by the configured entries; a configured code replaces its default. */
  datums: DatumMapping[];
}

export const DEFAULT_ROUTE_CHECK = { speed: 2.5, xteLimit: 30, probability: 0.01 } as const;

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

const DEG = Math.PI / 180;

/** A configured angle in degrees (or °/s) as radians; the radian fallback is kept exact. */
function degrees(v: unknown, fallback: number, min: number, max: number): number {
  const d = num(v, NaN, min, max);
  return Number.isNaN(d) ? fallback : d * DEG;
}

/** Heel gives no credit unless the configuration sets a heel model: the keel counts at full depth. */
function heelModel(v: Record<string, unknown>): HeelModel {
  if (v.keel === "fin") {
    return { kind: "fin" };
  }
  if (v.keel === "table" && Array.isArray(v.heelTable)) {
    const points = v.heelTable
      .map(record)
      .filter((p) => typeof p.heel === "number" && typeof p.delta === "number")
      .map((p) => ({ heel: (p.heel as number) * DEG, delta: p.delta as number }));
    return points.length > 0 ? { kind: "table", points } : { kind: "none" };
  }
  return { kind: "none" };
}

function parseDynamics(v: Record<string, unknown>): DynamicsOptions {
  const d = DEFAULT_DYNAMICS;
  return {
    blockCoefficient: num(v.blockCoefficient, d.blockCoefficient, 0, 1),
    confined: v.confined === true,
    heel: heelModel(v),
    waveFactor: num(v.waveFactor, d.waveFactor, 0, 2),
    draftSigma: num(v.draftSigma, d.draftSigma, 0, 5),
    margin: num(v.margin, d.margin, 0, 10)
  };
}

const SOURCES = ["none", "manual", "signalk-tide", "fmi"] as const;

function parseDatums(v: unknown): DatumMapping[] {
  const configured = (Array.isArray(v) ? v : [])
    .map(record)
    .filter(
      (d) =>
        typeof d.verdat === "number" &&
        Number.isInteger(d.verdat) &&
        (d.series === "mw" || d.series === "n2000")
    )
    .map((d) => ({
      verdat: d.verdat as number,
      series: d.series as DatumMapping["series"],
      sigma: num(d.sigma, 0.05, 0, 2)
    }));
  const codes = new Set(configured.map((d) => d.verdat));
  return [...DEFAULT_DATUMS.filter((d) => !codes.has(d.verdat)), ...configured];
}

function parseWaterLevel(w: Record<string, unknown>): WaterLevelConfig {
  const source = SOURCES.find((s) => s === w.source) ?? "none";
  return {
    source,
    height: num(w.height, 0, -10, 10),
    sigma: num(w.sigma, 0.1, 0, 5),
    updateInterval: num(w.updateInterval, 600, 60, 1800),
    datums: parseDatums(w.datums)
  };
}

function parseLookahead(l: Record<string, unknown>, style: WarningStyle): LookaheadOptions {
  const d = DEFAULT_LOOKAHEAD;
  const p = WARNING_PRESETS[style];
  const alert = num(l.alertRisk, p.alertRisk, 1e-6, 1);
  const warn = Math.max(alert, num(l.warnRisk, p.warnRisk, 1e-6, 1));
  const alarm = Math.max(warn, num(l.alarmRisk, p.alarmRisk, 1e-6, 1));
  const alarmWithin = num(l.alarmWithin, p.alarmWithin, 0);
  return {
    ...d,
    distance: Math.min(num(l.distance, p.distance, 0), LOOKAHEAD_LIMITS.distance),
    minHorizon: Math.min(num(l.minHorizon, d.minHorizon, 0), LOOKAHEAD_LIMITS.minHorizon),
    positionBuffer: num(l.positionBuffer, d.positionBuffer, 0),
    kp: num(l.kp, d.kp, 0, 5),
    sigmaCog: degrees(l.sigmaCog, d.sigmaCog, 0, 45),
    sigmaRot: degrees(l.sigmaRot, d.sigmaRot, 0, 10),
    maxTurnRate: degrees(l.maxTurnRate, d.maxTurnRate, 0.1, 30),
    thresholds: { alert, warn, alarm },
    // A window for a more severe state wider than a milder one's would skip the milder state.
    warnWithin: Math.max(num(l.warnWithin, p.warnWithin, 0), alarmWithin),
    alarmWithin,
    certainWithin: Math.min(num(l.certainWithin, p.certainWithin, 0), alarmWithin)
  };
}

function parseLivechart(l: Record<string, unknown>): LivechartConfig | undefined {
  if (l.enabled !== true) {
    return undefined;
  }
  const below = l.source === "belowTransducer";
  return {
    source: {
      path: below ? "environment.depth.belowTransducer" : "environment.depth.belowSurface",
      transducerDepth: num(l.transducerDepth, 0, 0, 10),
      forward: num(l.forward, 0, -100, 100),
      starboard: num(l.starboard, 0, -50, 50)
    },
    writeNotes: l.writeNotes !== false,
    csb: {
      id: str(l.vesselId) ?? "anonymous",
      idType: l.vesselIdType === "MMSI" || l.vesselIdType === "IMO" ? l.vesselIdType : "Other",
      sounderMake: str(l.sounderMake),
      sounderModel: str(l.sounderModel)
    }
  };
}

/** CATZOC letters as configured, to S-57 codes. */
const CATZOC_CODES: Record<string, number> = { A1: 1, A2: 2, B: 3, C: 4, D: 5, U: 6 };

function parseWfs(w: Record<string, unknown>): WfsConfig | undefined {
  if (w.enabled !== true) {
    return undefined;
  }
  return {
    url: str(w.url) ?? DEFAULT_WFS_URL,
    radiusKm: num(w.radiusKm, 10, WFS_LIMITS.minRadiusKm, WFS_LIMITS.maxRadiusKm),
    catzoc: CATZOC_CODES[str(w.catzoc) ?? "B"] ?? 3
  };
}

function parseGrounding(g: Record<string, unknown>): GroundingOptions | undefined {
  if (g.enabled !== true) {
    return undefined;
  }
  return {
    imuPath: str(g.imuPath),
    decelThreshold: num(g.decelThreshold, DEFAULT_GROUNDING.decelThreshold, 0.1, 50)
  };
}

/** 0 builds every cell; a box smaller than the WFS minimum is raised to it, not reset to 10 km. */
function boxRadius(v: unknown): number {
  const km = num(v, 10, 0, 50);
  return km === 0 ? 0 : Math.max(WFS_LIMITS.minRadiusKm, km);
}

export function parseConfig(raw: unknown): PluginConfig {
  const r = record(raw);
  const v = record(r.vessel);
  const rc = record(r.routeCheck);
  const style = warningStyle(r.warningStyle);
  return {
    indexDir: str(r.indexDir),
    cellsDir: str(r.cellsDir),
    rebuildIndex: r.rebuildIndex === true,
    leafZoom: Math.round(num(r.leafZoom, 20, 14, 22)),
    boxRadiusKm: boxRadius(r.boxRadiusKm),
    boxMaxRadiusKm: num(r.boxMaxRadiusKm, 0, 0, MAX_BOX_KM),
    warningStyle: style,
    vessel: {
      draft: optionalPositive(v.draft),
      length: optionalPositive(v.length),
      beam: optionalPositive(v.beam)
    },
    dynamics: parseDynamics(v),
    waterLevel: parseWaterLevel(record(r.waterLevel)),
    lookahead: parseLookahead(record(r.lookahead), style),
    livechart: parseLivechart(record(r.livechart)),
    mooringZones: (Array.isArray(r.mooringZones) ? r.mooringZones : [])
      .map(str)
      .filter((id): id is string => id !== undefined),
    groundingDetector: parseGrounding(record(r.groundingDetector)),
    wfs: parseWfs(record(r.wfs)),
    routeCheck: {
      speed: num(rc.speed, DEFAULT_ROUTE_CHECK.speed, LIMITS.minSpeed, LIMITS.maxSpeed),
      xteLimit: num(rc.xteLimit, DEFAULT_ROUTE_CHECK.xteLimit, 0, LIMITS.maxXte),
      probability: num(
        rc.probability,
        DEFAULT_ROUTE_CHECK.probability,
        LIMITS.minProbability,
        LIMITS.maxProbability
      )
    }
  };
}
