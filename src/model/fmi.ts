import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { LevelSeries } from "../ingest/datum";
import type { LevelReach, LevelSample, ProviderHealth, WaterLevelProvider } from "./water-level";

/**
 * Finnish Meteorological Institute open data (plan §4.5): the sea-level
 * forecast at the vessel's position and the latest tide-gauge reading at
 * the nearest station, blended so the level starts at the observation and
 * relaxes to the forecast.
 *
 * Stored queries and units, checked against opendata.fmi.fi on 2026-10-17:
 * - `fmi::forecast::sealevel::point::simple`: SeaLevel (theoretical mean
 *   water) and SeaLevelN2000, in centimetres, hourly for 48 h.
 * - `fmi::observations::mareograph::instant::simple`: WATLEV (theoretical
 *   mean water) and WLEVN2K_PT1S_INSTANT (N2000), in millimetres.
 */

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface Station {
  fmisid: number;
  name: string;
  position: LonLat;
}

/** The 14 FMI mareograph stations on the Finnish coast. */
export const MAREOGRAPHS: readonly Station[] = [
  { fmisid: 100539, name: "Kemi Ajos", position: [24.51526, 65.67337] },
  { fmisid: 134248, name: "Oulu Toppila", position: [25.4182, 65.0403] },
  { fmisid: 100540, name: "Raahe Lapaluoto", position: [24.40708, 64.6663] },
  { fmisid: 134250, name: "Pietarsaari Leppäluoto", position: [22.68958, 63.70857] },
  { fmisid: 134223, name: "Vaasa Vaskiluoto", position: [21.57118, 63.0815] },
  { fmisid: 134251, name: "Kaskinen Ådskär", position: [21.21483, 62.34395] },
  { fmisid: 134266, name: "Pori Mäntyluoto Kallo", position: [21.46343, 61.59438] },
  { fmisid: 134224, name: "Rauma Petäjäs", position: [21.44263, 61.1339] },
  { fmisid: 134225, name: "Turku Ruissalo Saaronniemi", position: [22.10053, 60.42828] },
  { fmisid: 134252, name: "Föglö Degerby", position: [20.38482, 60.03188] },
  { fmisid: 134253, name: "Hanko Pikku Kolalahti", position: [22.97658, 59.82287] },
  { fmisid: 132310, name: "Helsinki Kaivopuisto", position: [24.95622, 60.15363] },
  { fmisid: 100669, name: "Porvoo Emäsalo Vaarlahti", position: [25.62509, 60.20579] },
  { fmisid: 134254, name: "Hamina Pitäjänsaari", position: [27.1792, 60.56277] }
];

const BASE_URL = "https://opendata.fmi.fi/wfs";
const FORECAST_QUERY = "fmi::forecast::sealevel::point::simple";
const OBSERVATION_QUERY = "fmi::observations::mareograph::instant::simple";

const FORECAST_PARAMS: Record<LevelSeries, string> = { mw: "SeaLevel", n2000: "SeaLevelN2000" };
const OBSERVATION_PARAMS: Record<LevelSeries, string> = {
  mw: "WATLEV",
  n2000: "WLEVN2K_PT1S_INSTANT"
};

/**
 * Uncertainty defaults, not yet calibrated against FMI forecast-versus-
 * observation history (plan §4.5 follow-up): a gauge reading is good to a
 * few centimetres plus a term for the distance to the vessel, and the
 * forecast error grows with lead time.
 */
export const FMI_SIGMA = {
  observation: 0.03,
  perStationKm: 0.002,
  forecast: 0.1,
  perLeadHour: 0.02,
  max: 0.5
} as const;

/** A gauge further than this from the vessel says little about its water. */
const MAX_STATION_KM = 60;
/** An observation older than this is not blended in. */
const MAX_OBSERVATION_AGE_MS = 60 * 60 * 1000;
/** The observation's offset from the forecast decays with this time constant. */
const BLEND_TAU_MS = 6 * 3600 * 1000;
/** A forecast fetched further away than this (metres) is not used for a position. */
export const FORECAST_REACH_METRES = 30000;
const REQUEST_TIMEOUT_MS = 15000;

type Series = [t: number, h: number][];

interface Forecast {
  fetchedAt: number;
  position: LonLat;
  series: Record<LevelSeries, Series>;
}

interface Observation {
  station: Station;
  km: number;
  latest: Partial<Record<LevelSeries, { t: number; h: number }>>;
}

/** Parses a WFS "simple" feature response into one time series per parameter. */
export function parseSimpleFeatures(xml: string): Map<string, Series> {
  const out = new Map<string, Series>();
  const element = /<BsWfs:BsWfsElement[\s\S]*?<\/BsWfs:BsWfsElement>/g;
  for (const match of xml.matchAll(element)) {
    const block = match[0];
    const time = /<BsWfs:Time>([^<]+)<\/BsWfs:Time>/.exec(block)?.[1];
    const name = /<BsWfs:ParameterName>([^<]+)<\/BsWfs:ParameterName>/.exec(block)?.[1];
    const value = /<BsWfs:ParameterValue>([^<]+)<\/BsWfs:ParameterValue>/.exec(block)?.[1];
    const t = time ? Date.parse(time) : NaN;
    const h = value ? Number(value) : NaN;
    if (name === undefined || !Number.isFinite(t) || !Number.isFinite(h)) {
      continue;
    }
    const series = out.get(name) ?? [];
    series.push([t, h]);
    out.set(name, series);
  }
  for (const series of out.values()) {
    series.sort((a, b) => a[0] - b[0]);
  }
  return out;
}

/** Linear interpolation inside the series; undefined outside it. */
export function interpolate(series: Series, t: number): number | undefined {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || t < first[0] || t > last[0]) {
    return undefined;
  }
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((series[mid] as [number, number])[0] <= t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const [t0, h0] = series[lo] as [number, number];
  const [t1, h1] = series[hi] as [number, number];
  return t1 === t0 ? h0 : h0 + ((h1 - h0) * (t - t0)) / (t1 - t0);
}

export function nearestStation(position: LonLat): { station: Station; km: number } {
  let best = { station: MAREOGRAPHS[0] as Station, km: Infinity };
  for (const station of MAREOGRAPHS) {
    const km = haversine(position, station.position) / 1000;
    if (km < best.km) {
      best = { station, km };
    }
  }
  return best;
}

function query(base: string, params: Record<string, string>): string {
  const q = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "getFeature",
    ...params
  });
  return `${base}?${q.toString()}`;
}

export class FmiProvider implements WaterLevelProvider {
  readonly id = "fmi";
  readonly reference = "series";
  private forecast?: Forecast;
  private observation?: Observation;
  private error?: string;
  private inFlight?: Promise<void>;
  private readonly controller = new AbortController();

  constructor(
    private readonly fetch: FetchLike,
    private readonly base = BASE_URL
  ) {}

  /** Cancels any request in flight; later updates do nothing. */
  abort(): void {
    this.controller.abort();
  }

  /** Where the held forecast was fetched for, if any. */
  forecastPosition(): LonLat | undefined {
    return this.forecast?.position;
  }

  /** Refreshes the forecast and observation for `position`; never rejects. */
  update(position: LonLat, now: number): Promise<void> {
    if (this.controller.signal.aborted) {
      return Promise.resolve();
    }
    this.inFlight ??= this.fetchAll(position, now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchAll(position: LonLat, now: number): Promise<void> {
    const start = new Date(now - 2 * 3600 * 1000).toISOString();
    const nearest = nearestStation(position);
    const [forecast, observation] = await Promise.allSettled([
      this.get({
        storedquery_id: FORECAST_QUERY,
        latlon: `${position[1].toFixed(4)},${position[0].toFixed(4)}`,
        parameters: Object.values(FORECAST_PARAMS).join(","),
        starttime: start
      }),
      nearest.km <= MAX_STATION_KM
        ? this.get({
            storedquery_id: OBSERVATION_QUERY,
            fmisid: String(nearest.station.fmisid),
            parameters: Object.values(OBSERVATION_PARAMS).join(","),
            starttime: start
          })
        : Promise.resolve(undefined)
    ]);
    if (this.controller.signal.aborted) {
      return;
    }
    if (forecast.status === "rejected") {
      this.error = `forecast request failed: ${String(forecast.reason)}`;
      return;
    }
    const fc = parseSimpleFeatures(forecast.value);
    const series = {
      mw: centimetres(fc.get(FORECAST_PARAMS.mw)),
      n2000: centimetres(fc.get(FORECAST_PARAMS.n2000))
    };
    if (series.mw.length === 0 && series.n2000.length === 0) {
      this.error = "forecast response held no sea-level values";
      return;
    }
    this.forecast = { fetchedAt: now, position, series };
    this.error = undefined;
    this.observation =
      observation.status === "fulfilled" && observation.value !== undefined
        ? observationFrom(parseSimpleFeatures(observation.value), nearest)
        : undefined;
  }

  private async get(params: Record<string, string>): Promise<string> {
    const res = await this.fetch(query(this.base, params), {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.text();
  }

  levelAt(position: LonLat | undefined, t: number, series: LevelSeries): LevelSample | undefined {
    const fc = this.forecast;
    if (!fc || (position && haversine(position, fc.position) > FORECAST_REACH_METRES)) {
      return undefined;
    }
    const s = fc.series[series];
    const forecastNow = interpolate(s, t);
    const obs = this.observation?.latest[series];
    const obsUsable = obs !== undefined && fc.fetchedAt - obs.t <= MAX_OBSERVATION_AGE_MS;
    if (obsUsable) {
      const lead = Math.max(0, t - obs.t);
      const sigma = Math.min(
        FMI_SIGMA.max,
        Math.hypot(
          FMI_SIGMA.observation + FMI_SIGMA.perStationKm * (this.observation as Observation).km,
          FMI_SIGMA.perLeadHour * (lead / 3600000)
        )
      );
      const anchor = interpolate(s, obs.t) ?? firstWithin(s, obs.t, MAX_OBSERVATION_AGE_MS);
      if (forecastNow !== undefined && anchor !== undefined) {
        const w = Math.exp(-lead / BLEND_TAU_MS);
        return { h: forecastNow + (obs.h - anchor) * w, sigma, source: "fmi:blend" };
      }
      if (lead <= MAX_OBSERVATION_AGE_MS) {
        return { h: obs.h, sigma, source: "fmi:observation" };
      }
    }
    if (forecastNow === undefined) {
      return undefined;
    }
    const lead = Math.max(0, t - fc.fetchedAt);
    const sigma = Math.min(
      FMI_SIGMA.max,
      Math.hypot(FMI_SIGMA.forecast, FMI_SIGMA.perLeadHour * (lead / 3600000))
    );
    return { h: forecastNow, sigma, source: "fmi:forecast" };
  }

  /**
   * Where levelAt answers: nothing in it depends on position but the
   * distance to the point the forecast was fetched for.
   */
  reach(): LevelReach | undefined {
    return this.forecast && { centre: this.forecast.position, metres: FORECAST_REACH_METRES };
  }

  /** The forecast points in [start, end], where the interpolated level turns. */
  knots(start: number, end: number): number[] {
    const fc = this.forecast;
    const times = fc ? [...fc.series.mw, ...fc.series.n2000].map(([t]) => t) : [];
    return [...new Set(times.filter((t) => t >= start && t <= end))];
  }

  health(): ProviderHealth {
    if (!this.forecast) {
      return { ok: false, message: this.error ?? "no forecast fetched yet" };
    }
    return { ok: true, lastUpdate: this.forecast.fetchedAt, message: this.error };
  }
}

/** The first value when it lies within `within` ms after `t`. */
function firstWithin(series: Series, t: number, within: number): number | undefined {
  const first = series[0];
  return first && first[0] >= t && first[0] - t <= within ? first[1] : undefined;
}

function centimetres(series: Series | undefined): Series {
  return (series ?? []).map(([t, h]) => [t, h / 100]);
}

function observationFrom(
  obs: Map<string, Series>,
  nearest: { station: Station; km: number }
): Observation {
  const latest: Observation["latest"] = {};
  for (const series of ["mw", "n2000"] as const) {
    const last = obs.get(OBSERVATION_PARAMS[series])?.at(-1);
    if (last) {
      latest[series] = { t: last[0], h: last[1] / 1000 };
    }
  }
  return { ...nearest, latest };
}
