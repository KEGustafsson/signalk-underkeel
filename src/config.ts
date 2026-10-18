import type { LookaheadOptions } from "./engine/lookahead";
import { DEFAULT_LOOKAHEAD } from "./engine/lookahead";
import type { HeelModel } from "./model/allowances";
import type { DatumMapping } from "./ingest/datum";
import { DEFAULT_DATUMS } from "./ingest/datum";
import type { DynamicsOptions, VesselModel } from "./model/vessel";
import { DEFAULT_DYNAMICS } from "./model/vessel";
import { LIMITS } from "./api/route-request";

export { SCHEMA } from "./config-schema";

/**
 * Plugin configuration parsed into typed options. Out-of-range or
 * malformed values fall back to the defaults. Distances are metres, times
 * seconds, angles in the configuration degrees.
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
  dynamics: DynamicsOptions;
  waterLevel: WaterLevelConfig;
  lookahead: LookaheadOptions;
  routeCheck: {
    /** Planning speed when a request gives none, m/s. */
    speed: number;
    /** Cross-track limit when a request gives none, metres. */
    xteLimit: number;
    /** A leg passes when P(UKC < 0) is below this. */
    probability: number;
  };
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

function parseLookahead(l: Record<string, unknown>): LookaheadOptions {
  const d = DEFAULT_LOOKAHEAD;
  const alert = num(l.alertRisk, d.thresholds.alert, 1e-6, 1);
  const warn = Math.max(alert, num(l.warnRisk, d.thresholds.warn, 1e-6, 1));
  const alarm = Math.max(warn, num(l.alarmRisk, d.thresholds.alarm, 1e-6, 1));
  const alarmWithin = num(l.alarmWithin, d.alarmWithin, 0);
  return {
    ...d,
    distance: num(l.distance, d.distance, 0),
    minHorizon: num(l.minHorizon, d.minHorizon, 0),
    positionBuffer: num(l.positionBuffer, d.positionBuffer, 0),
    thresholds: { alert, warn, alarm },
    // A window for a more severe state wider than a milder one's would skip the milder state.
    warnWithin: Math.max(num(l.warnWithin, d.warnWithin, 0), alarmWithin),
    alarmWithin,
    certainWithin: Math.min(num(l.certainWithin, d.certainWithin, 0), alarmWithin)
  };
}

export function parseConfig(raw: unknown): PluginConfig {
  const r = record(raw);
  const v = record(r.vessel);
  const rc = record(r.routeCheck);
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
    dynamics: parseDynamics(v),
    waterLevel: parseWaterLevel(record(r.waterLevel)),
    lookahead: parseLookahead(record(r.lookahead)),
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
