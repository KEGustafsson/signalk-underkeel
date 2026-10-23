import type { LonLat } from "../foundation/geo";
import type { DatumUse, LevelSeries } from "../ingest/datum";
import type { WaterLevel } from "./uncertainty";

/**
 * Water-level providers (plan §4.5) and the resolution of their readings
 * into the level the engine applies. A provider answers from data it
 * already holds, so the 1 Hz loop never waits on the network; providers
 * that fetch refresh themselves on their own schedule.
 */

export interface LevelSample {
  /** Height of the water above the reference, metres. */
  h: number;
  sigma: number;
  source: string;
}

export interface ProviderHealth {
  ok: boolean;
  /** Epoch ms of the newest data. */
  lastUpdate?: number;
  message?: string;
}

export interface WaterLevelProvider {
  readonly id: string;
  /**
   * "chart": samples are already above chart datum (manual, Signal K tide).
   * "series": samples are above a named series and need each cell's datum.
   */
  readonly reference: "chart" | "series";
  levelAt(position: LonLat | undefined, t: number, series: LevelSeries): LevelSample | undefined;
  health(now: number): ProviderHealth;
  /**
   * Times in [start, end] where the level can turn, e.g. forecast points;
   * an interval minimum is sampled there as well as on a fixed step.
   */
  knots?(start: number, end: number): number[];
}

/** With no usable water level the engine works at chart datum with this σ. */
export const CHART_DATUM_SIGMA = 0.3;

/** A provider whose newest data is older than this is stale (plan §4.5). */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** Spacing of samples when a level is needed over an interval. */
const INTERVAL_STEP_MS = 10 * 60 * 1000;
const MAX_INTERVAL_SAMPLES = 300;

export const CHART_DATUM: WaterLevel = { h: 0, sigma: CHART_DATUM_SIGMA, source: "chart-datum" };

/**
 * Chart datum, or the last level the source gave when that was lower: Baltic
 * levels are often below chart datum, and falling back to 0 would assume
 * more water than was last seen.
 */
function fallback(reason: string, last: number): WaterLevel {
  return { h: Math.min(0, last), sigma: CHART_DATUM_SIGMA, source: "fallback", degraded: reason };
}

/** A constant height above chart datum with a user-set σ. */
export function manualProvider(h: number, sigma: number): WaterLevelProvider {
  return {
    id: "manual",
    reference: "chart",
    levelAt: () => ({ h, sigma, source: "manual" }),
    health: (now) => ({ ok: true, lastUpdate: now })
  };
}

/** heightNow stands for the level only this long after it was read. */
const TIDE_NOW_HOLD_MS = 5 * 60 * 1000;
/**
 * The next low water bounds the level until the flood after it has turned:
 * about 6 h past timeLow on a semi-diurnal tide. Without timeLow the low may
 * be due at once, so the bound ends 6 h after the reading.
 */
const TIDE_LOW_HOLD_MS = 6 * 3600 * 1000;

/**
 * Reads `environment.tide.*` from whatever tide provider is installed in
 * Signal K. Only the current height and the next low water are published
 * there: heightNow holds for a few minutes, then the tide may be falling,
 * so the lower of heightNow and heightLow applies until six hours past the
 * next low water, and nothing is known after that.
 */
export class SignalKTideProvider implements WaterLevelProvider {
  readonly id = "signalk-tide";
  readonly reference = "chart";
  private now?: { h: number; at: number };
  private low?: number;
  private timeLow?: number;

  constructor(private readonly sigma: number) {}

  /** Feeds one Signal K value; returns whether the path was a tide path. */
  record(path: string, value: unknown, at: number): boolean {
    const h = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    if (path === "environment.tide.heightNow") {
      this.now = h === undefined ? undefined : { h, at };
      return true;
    }
    if (path === "environment.tide.heightLow") {
      this.low = h;
      return true;
    }
    if (path === "environment.tide.timeLow") {
      const t = typeof value === "string" ? Date.parse(value) : NaN;
      this.timeLow = Number.isFinite(t) ? t : undefined;
      return true;
    }
    return false;
  }

  levelAt(_position: LonLat | undefined, t: number): LevelSample | undefined {
    if (!this.now) {
      return undefined;
    }
    if (t - this.now.at <= TIDE_NOW_HOLD_MS) {
      return { h: this.now.h, sigma: this.sigma, source: "signalk-tide" };
    }
    const until = (this.timeLow ?? this.now.at) + TIDE_LOW_HOLD_MS;
    if (this.low === undefined || t > until) {
      return undefined;
    }
    return { h: Math.min(this.now.h, this.low), sigma: this.sigma, source: "signalk-tide" };
  }

  health(): ProviderHealth {
    return this.now
      ? { ok: true, lastUpdate: this.now.at }
      : { ok: false, message: "no environment.tide.heightNow received" };
  }
}

/** Why the provider cannot be used now, or undefined when it can. */
function unusable(p: WaterLevelProvider, now: number): string | undefined {
  const health = p.health(now);
  if (!health.ok) {
    return `water level from ${p.id}: ${health.message ?? "no data"}`;
  }
  if (health.lastUpdate === undefined) {
    return `water level from ${p.id}: no data`;
  }
  const age = now - health.lastUpdate;
  if (age > STALE_AFTER_MS) {
    return `water level from ${p.id} is ${Math.round(age / 60000)} min old`;
  }
  return undefined;
}

/** The level at `t`, or why there is none. */
function sampleAt(
  p: WaterLevelProvider,
  uses: readonly DatumUse[],
  position: LonLat | undefined,
  t: number
): WaterLevel | string {
  if (p.reference === "chart") {
    const s = p.levelAt(position, t, "mw");
    return s ? { ...s } : `water level from ${p.id}: no value for ${iso(t)}`;
  }
  // Cells on different datums share one level: take the lowest and the
  // widest σ, which per invariant 2 can only raise P(UKC < 0).
  let out: WaterLevel | undefined;
  const unknown: string[] = [];
  for (const use of uses) {
    const s = p.levelAt(position, t, use.series);
    if (!s) {
      return `water level from ${p.id}: no ${use.series} value for ${iso(t)}`;
    }
    if (!use.known) {
      unknown.push(...use.cells);
    }
    const sigma = Math.hypot(s.sigma, use.sigma);
    out = out
      ? { ...out, h: Math.min(out.h, s.h), sigma: Math.max(out.sigma, sigma) }
      : { h: s.h, sigma, source: s.source };
  }
  if (!out) {
    return "no chart cells to relate the water level to";
  }
  if (unknown.length > 0) {
    out.note = `vertical datum unknown for ${unknown.join(", ")}`;
  }
  return out;
}

/**
 * The level at the source's newest data, from wherever it was fetched, or 0
 * when there is none.
 */
function lastLevel(p: WaterLevelProvider, uses: readonly DatumUse[], now: number): number {
  const at = p.health(now).lastUpdate;
  const wl = at === undefined ? undefined : sampleAt(p, uses, undefined, at);
  return typeof wl === "object" ? wl.h : 0;
}

function iso(t: number): string {
  return new Date(t).toISOString();
}

/**
 * S-57 VERDAT codes of low-water datums: the tide seldom leaves less water
 * than charted, so chart datum with σ 0.3 m stands in for an unknown level.
 */
const LOW_WATER_DATUMS = new Set([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 22, 23, 27]);

/**
 * Chart datum, as the level with no source. Where a cell states a datum that
 * is not low water (mean water in the Baltic, high water, local) the water
 * is often well below it, so the level is degraded rather than applied as if
 * measured. The reason names those datums and the source to set: fmi when
 * one of them is mapped to an FMI series, else signalk-tide or manual. It
 * never suggests adding a datum mapping, and holds no colon, since
 * describe() adds one before its explanation. A cell that states none, in
 * practice the advisory Traficom WFS cell, is taken at chart datum as before.
 */
function noSource(uses: readonly DatumUse[]): WaterLevel {
  const other = new Set<number>();
  let fmi = false;
  for (const use of uses) {
    for (const verdat of [use.verdat, ...(use.datumAreas ?? [])]) {
      if (verdat !== undefined && !LOW_WATER_DATUMS.has(verdat)) {
        other.add(verdat);
        // A known use has no datum areas: this is its own datum, mapped to an FMI series.
        fmi ||= use.known;
      }
    }
  }
  if (other.size === 0) {
    return CHART_DATUM;
  }
  const datums = [...other].map((v) => `VERDAT ${v}`).join(", ");
  const fix = fmi
    ? "fmi in Finnish waters, or to signalk-tide or manual"
    : "signalk-tide or manual";
  return {
    ...CHART_DATUM,
    degraded: `no water-level source, and chart datum is not low water (${datums}); set Water level source to ${fix}`
  };
}

/**
 * The level to apply at time `t`. No provider means chart datum, degraded
 * where a cell states a datum that is not low water, with a reason naming
 * those datums and the source to set; a provider that is unhealthy,
 * stale for more than 30 minutes or without a value for `t` falls back to
 * chart datum, or its last level when lower, with σ 0.3 m and a `degraded`
 * reason, never silently.
 */
export function resolveWaterLevel(
  p: WaterLevelProvider | undefined,
  uses: readonly DatumUse[],
  position: LonLat | undefined,
  t: number,
  now: number
): WaterLevel {
  if (!p) {
    return noSource(uses);
  }
  const wl = unusable(p, now) ?? sampleAt(p, uses, position, t);
  return typeof wl === "string" ? fallback(wl, lastLevel(p, uses, now)) : wl;
}

/**
 * The lower of two levels with the wider σ. A fallback's reason and source
 * win, but not its height: a lower level already found still applies, since
 * the fallback can sit well above what the source forecast.
 */
export function lowerLevel(a: WaterLevel | undefined, b: WaterLevel): WaterLevel {
  if (!a) {
    return b;
  }
  const base = a.degraded === undefined && b.degraded !== undefined ? b : a;
  return { ...base, h: Math.min(a.h, b.h), sigma: Math.max(a.sigma, b.sigma) };
}

/**
 * The lowest level, with the widest σ, over [start, end]. Any fallback makes
 * the result degraded, at no more water than the lowest level found.
 */
export function lowestWaterLevel(
  p: WaterLevelProvider | undefined,
  uses: readonly DatumUse[],
  position: LonLat | undefined,
  start: number,
  end: number,
  now: number
): WaterLevel {
  const step = Math.max(INTERVAL_STEP_MS, (end - start) / MAX_INTERVAL_SAMPLES);
  const times = [start, end, ...(p?.knots?.(start, end) ?? [])];
  for (let t = start + step; t < end; t += step) {
    times.push(t);
  }
  let out: WaterLevel | undefined;
  for (const t of times.sort((a, b) => a - b)) {
    out = lowerLevel(out, resolveWaterLevel(p, uses, position, t, now));
  }
  return out as WaterLevel;
}
