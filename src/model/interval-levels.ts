import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { DatumUse } from "../ingest/datum";
import type { WaterLevel } from "./uncertainty";
import type { WaterLevelProvider } from "./water-level";
import { highestWaterLevel, lowestWaterLevel, usable } from "./water-level";

/**
 * The lowest and the highest level over an interval, found once. A planning session asks the
 * level for every box and leg it checks, each at its corners and each over the trip's window:
 * with the FMI forecast, every one sampled the forecast across the window again, 12.4 s of a
 * 30.5 s plan from Turku to Nauvo in the running server (63 179 boxes).
 *
 * A provider's level depends on position only by its reach (`WaterLevelProvider.reach`): the
 * same at every position within it, none beyond. So while its `revision` stands and its data
 * is usable, the level over [start, end] for one set of datums is one of three values: with no
 * position, within the reach, beyond it. Each is kept the first time it is found. A provider
 * without a `revision`, or one whose data is stale or missing, is asked every time.
 */

/** Intervals kept at most: a plan asks a few hundred, the trip's window and each leg's own. */
const MAX_KEPT = 4096;

type Find = (
  p: WaterLevelProvider | undefined,
  uses: readonly DatumUse[],
  position: LonLat | undefined,
  start: number,
  end: number,
  now: number
) => WaterLevel;

/** Where `position` lies for the provider: 0 with none, 1 within its reach, 2 beyond it. */
function side(p: WaterLevelProvider, position: LonLat | undefined): number {
  const reach = position && p.reach?.();
  if (!position) {
    return 0;
  }
  return reach && haversine(position, reach.centre) > reach.metres ? 2 : 1;
}

export class IntervalLevels {
  private revision: number | undefined;
  private readonly kept = new Map<string, WaterLevel>();
  private readonly ids = new WeakMap<readonly DatumUse[], number>();
  private count = 0;

  /** `lowestWaterLevel`, kept. */
  lowest: Find = (...q) => this.found("low", lowestWaterLevel, q);

  /** `highestWaterLevel`, kept. */
  highest: Find = (...q) => this.found("high", highestWaterLevel, q);

  private idOf(uses: readonly DatumUse[]): number {
    let id = this.ids.get(uses);
    if (id === undefined) {
      id = this.count++;
      this.ids.set(uses, id);
    }
    return id;
  }

  private found(kind: string, find: Find, q: Parameters<Find>): WaterLevel {
    const [p, uses, position, start, end, now] = q;
    const revision = p?.revision?.();
    if (!p || revision === undefined || !usable(p, now)) {
      return find(...q);
    }
    if (revision !== this.revision || this.kept.size >= MAX_KEPT) {
      this.kept.clear();
      this.revision = revision;
    }
    const key = `${kind} ${this.idOf(uses)} ${side(p, position)} ${start} ${end}`;
    let level = this.kept.get(key);
    if (!level) {
      level = find(...q);
      this.kept.set(key, level);
    }
    // A copy: a caller may fold it into another level or add a note to it.
    return { ...level };
  }
}
