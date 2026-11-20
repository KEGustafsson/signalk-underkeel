import type { PluginConfig } from "./config";
import type { LonLat } from "./foundation/geo";
import { haversine, project } from "./foundation/geo";
import type { CellInfo } from "./ingest/cells";
import type { DatumUse } from "./ingest/datum";
import { datumUses } from "./ingest/datum";
import type { FetchLike } from "./model/fmi";
import { FmiProvider } from "./model/fmi";
import type { AreaLevels } from "./model/level-regimes";
import type { WaterLevel } from "./model/uncertainty";
import type { ProviderHealth, WaterLevelProvider } from "./model/water-level";
import {
  lowerLevel,
  highestWaterLevel,
  higherLevel,
  lowestWaterLevel,
  manualProvider,
  resolveWaterLevel,
  SignalKTideProvider,
  STALE_AFTER_MS
} from "./model/water-level";
import type { ChartIndex } from "./spatial/chart-index";

/**
 * The configured water-level source for the plugin: which Signal K paths it
 * needs, when FMI refetches, and the level for now or over an interval.
 */

/** FMI is re-fetched when the vessel is this far from the forecast point. */
const FMI_REFETCH_METRES = 10000;
/** A failed or moved-triggered FMI fetch is retried no sooner than this. */
const FMI_RETRY_MS = 60000;
/**
 * The forecast is refetched, and a failed refetch retried, once it is this
 * close to stale, whatever the interval, so a 30-minute interval or one
 * failed request never lets it go stale.
 */
const FMI_REFRESH_BEFORE_STALE_MS = 5 * 60 * 1000;

export const TIDE_PATHS = [
  "environment.tide.heightNow",
  "environment.tide.heightLow",
  "environment.tide.timeLow"
] as const;

/** What `GET /status` reports about the water level. */
export interface WaterLevelStatus {
  source: PluginConfig["waterLevel"]["source"];
  applied: WaterLevel;
  health?: ProviderHealth;
  datums: DatumUse[];
}

function createProvider(config: PluginConfig, fetch: FetchLike): WaterLevelProvider | undefined {
  const w = config.waterLevel;
  switch (w.source) {
    case "manual":
      return manualProvider(w.height, w.sigma);
    case "signalk-tide":
      return new SignalKTideProvider(w.sigma);
    case "fmi":
      return new FmiProvider(fetch);
    case "none":
      return undefined;
  }
}

export class WaterLevelService {
  private readonly provider: WaterLevelProvider | undefined;
  private datums: DatumUse[];
  private readonly mapped = new WeakMap<readonly CellInfo[], DatumUse[]>();
  private lastFetch = -Infinity;

  constructor(
    private readonly config: PluginConfig,
    index: ChartIndex | undefined,
    fetch: FetchLike
  ) {
    this.provider = createProvider(config, fetch);
    this.datums = index ? datumUses(index.catalogue.cells, config.waterLevel.datums) : [];
  }

  /** Re-maps the cells' vertical datums after the index changes. */
  setIndex(index: ChartIndex): void {
    this.datums = datumUses(index.catalogue.cells, this.config.waterLevel.datums);
  }

  /** Signal K paths the source reads. */
  paths(): readonly string[] {
    return this.provider instanceof SignalKTideProvider ? TIDE_PATHS : [];
  }

  /** Feeds a Signal K value; returns whether the source used it. */
  record(path: string, value: unknown, at: number): boolean {
    return this.provider instanceof SignalKTideProvider && this.provider.record(path, value, at);
  }

  /** Starts an FMI fetch when one is due, the forecast is near stale or the vessel left its area. */
  refresh(position: LonLat | undefined, now: number): void {
    const p = this.provider;
    if (!(p instanceof FmiProvider) || !position) {
      return;
    }
    const at = p.forecastPosition();
    const moved = at === undefined || haversine(at, position) > FMI_REFETCH_METRES;
    const age = now - (p.health().lastUpdate ?? -Infinity);
    const ageing = age >= STALE_AFTER_MS - FMI_REFRESH_BEFORE_STALE_MS;
    const since = now - this.lastFetch;
    if (
      since >= this.config.waterLevel.updateInterval * 1000 ||
      ((moved || ageing) && since >= FMI_RETRY_MS)
    ) {
      this.lastFetch = now;
      void p.update(position, now);
    }
  }

  stop(): void {
    if (this.provider instanceof FmiProvider) {
      this.provider.abort();
    }
  }

  /** The level the engine applies now. */
  now(position: LonLat | undefined, now: number): WaterLevel {
    return resolveWaterLevel(this.provider, this.datums, position, now, now);
  }

  /**
   * The lowest level over [start, end] (epoch ms) at any of `at`, for
   * route checks; a fallback at any position makes it degraded, at no more
   * water than the lowest level found elsewhere. FMI answers only within
   * its forecast distance of where the forecast was fetched, so a leg far
   * from the vessel falls back rather than taking the vessel's level.
   *
   * With `area`, `at` is a convex ring and the level holds for every point
   * inside it too: where the source's reach can meet the ring's box, the level
   * within the reach counts as well, so a ring whose vertices all lie beyond the
   * reach never gets more water than a point inside it that lies within it.
   */
  over(
    start: number,
    end: number,
    at: readonly LonLat[],
    now: number,
    area = false,
    cells?: readonly CellInfo[]
  ): WaterLevel {
    const datums = cells ? this.datumsOf(cells) : this.datums;
    let out: WaterLevel | undefined;
    for (const p of at) {
      out = lowerLevel(out, lowestWaterLevel(this.provider, datums, p, start, end, now));
    }
    const reach = area ? this.provider?.reach?.() : undefined;
    if (reach && mayMeet(at, reach.centre, reach.metres)) {
      out = lowerLevel(out, lowestWaterLevel(this.provider, datums, reach.centre, start, end, now));
    }
    return out ?? lowestWaterLevel(this.provider, datums, undefined, start, end, now);
  }

  /**
   * The highest level over [start, end] at any of `at`, each cell datum on its own, for what
   * passes overhead; with `area`, also within the source's reach where it can meet the ring.
   */
  highest(
    start: number,
    end: number,
    at: readonly LonLat[],
    now: number,
    area = false,
    cells?: readonly CellInfo[]
  ): WaterLevel {
    const datums = cells ? this.datumsOf(cells) : this.datums;
    let out: WaterLevel | undefined;
    for (const p of at) {
      out = higherLevel(out, highestWaterLevel(this.provider, datums, p, start, end, now));
    }
    const reach = area ? this.provider?.reach?.() : undefined;
    if (reach && mayMeet(at, reach.centre, reach.metres)) {
      out = higherLevel(
        out,
        highestWaterLevel(this.provider, datums, reach.centre, start, end, now)
      );
    }
    return out ?? highestWaterLevel(this.provider, datums, undefined, start, end, now);
  }

  /** The datum uses of another index's cells (a planning box), mapped once per catalogue. */
  private datumsOf(cells: readonly CellInfo[]): DatumUse[] {
    let uses = this.mapped.get(cells);
    if (!uses) {
      uses = datumUses(cells, this.config.waterLevel.datums);
      this.mapped.set(cells, uses);
    }
    return uses;
  }

  /**
   * The levels over areas now (UKC tiles, `POST /query`). Within the
   * source's reach every position gets the same level; beyond it every
   * position gets the same fallback, so two resolutions describe the whole map.
   */
  regimes(now: number): AreaLevels {
    const reach = this.provider?.reach?.();
    const inside = this.now(reach?.centre, now);
    if (!reach || inside.degraded !== undefined) {
      // A degraded level inside is the provider's fallback, the same h and σ at every
      // position: FMI adds `degraded` only through it.
      return { inside };
    }
    // Any point past the reach gives the same fallback; this one goes the way route legs do.
    const out = this.now(project(reach.centre, 0, 2 * reach.metres), now);
    return { inside, beyond: { level: lowerLevel(inside, out), reach } };
  }

  status(position: LonLat | undefined, now: number): WaterLevelStatus {
    return {
      source: this.config.waterLevel.source,
      applied: this.now(position, now),
      health: this.provider?.health(now),
      datums: this.datums
    };
  }
}

/**
 * False only when no point of the box round `ring` lies within `metres` of
 * `centre`. The box's point nearest `centre` in degrees is at most the box's
 * diagonal from the true nearest point, so allowing that much never misses a
 * box the disk meets.
 */
function mayMeet(ring: readonly LonLat[], centre: LonLat, metres: number): boolean {
  if (ring.length === 0) {
    return false;
  }
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const sw: LonLat = [Math.min(...lons), Math.min(...lats)];
  const ne: LonLat = [Math.max(...lons), Math.max(...lats)];
  const q: LonLat = [
    Math.min(Math.max(centre[0], sw[0]), ne[0]),
    Math.min(Math.max(centre[1], sw[1]), ne[1])
  ];
  return haversine(q, centre) <= metres + haversine(sw, ne);
}
