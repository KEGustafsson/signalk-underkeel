import type { LonLat, Rect, XY } from "../foundation/geo";
import { emptyRect, extendRect, toMercator, wrapLon } from "../foundation/geo";
import type { CellInfo } from "../ingest/cells";
import type { RuleFeature } from "../ingest/rule-features";
import { FAIRWAY_GAP, OVERHEAD_CLASSES, PREFERENCE_CLASSES } from "../ingest/rule-features";
import type { WaterLevel } from "../model/uncertainty";
import type { ChartIndex } from "../spatial/chart-index";
import { meetsRing } from "../spatial/rules";
import type { LegStatus } from "./route-check";

/**
 * What a corridor is held to besides depth (plan §4.11): the clearance under bridges and
 * overhead cables and pipes against the boat's air height, entry-prohibited restricted areas,
 * and the direction of traffic in a separation scheme's lanes. Each sets a flag and a status
 * that the leg's depth status cannot better.
 */

export type RuleStatus = "ok" | "unverified" | "fail";

export interface RuleVerdict {
  status: RuleStatus;
  flags: string[];
}

/** Clearance kept above the boat's air height, metres. */
export const AIR_MARGIN = 0.5;
/** VERDAT codes of datums the water does not rise above: HAT, the highest water level (inland). */
const HIGHEST_DATUMS = new Set([30, 28]);
/** VERDAT codes of high-water datums the water can rise above, by up to `HIGH_WATER_RISE`. */
const HIGH_WATER_DATUMS = new Set([16, 17, 18, 20, 21, 29]);
/** How far the water may rise above a mean high water datum, metres. */
const HIGH_WATER_RISE = 0.5;
/**
 * How far the water may stand above a clearance's datum when it cannot be related to the water
 * level, metres: a clearance this much over the air height and margin passes, marked
 * `CLEARANCE_RISE_ASSUMED`; a lower one is unverified.
 */
const UNKNOWN_RISE = 2;

/** RESARE's RESTRN: entry prohibited, entry restricted, area to be avoided. */
const ENTRY_PROHIBITED = 7;
const ENTRY_RESTRICTED = 8;
const TO_BE_AVOIDED = 14;

/** A lane is followed within this of its direction, degrees. */
const FOLLOW_DEG = 60;
/** ...and crossed within this of a right angle to it. */
const CROSS_DEG = 20;

export interface RuleWindow {
  /** The boat's air height, metres; absent, clearances are not checked. */
  airHeight?: number;
  /** The highest water over the corridor's window, above chart datum. */
  highWater?: () => WaterLevel;
  /** The leg's rhumb-line course, degrees true; absent for a box, whose course is not known. */
  course?: number;
}

const RANK: Record<RuleStatus, number> = { ok: 0, unverified: 1, fail: 2 };

/** Rule features no verdict reads: the planner's preferences, and the pilotage check's strips. */
const PREFERENCES: ReadonlySet<string> = new Set([...PREFERENCE_CLASSES, FAIRWAY_GAP]);

/** The width of the Mercator world, metres: a ring past ±180° meets features a world over. */
const WORLD = 2 * toMercator(180, 0)[0];

/**
 * The rule features `rings` meet that `wanted` reads, a leg's corridor pieces or a box. A ring is
 * unwrapped from its first vertex, so one across ±180° stays whole, and is looked up a world
 * over too on the side it reaches past, where the features keep their own longitudes.
 */
function met(
  index: ChartIndex,
  rings: readonly (readonly LonLat[])[],
  wanted: (f: RuleFeature) => boolean
): RuleFeature[] {
  if (index.rules.size === 0) {
    return [];
  }
  const out = new Set<RuleFeature>();
  for (const ring of rings) {
    const lon0 = ring[0]?.[0] ?? 0;
    const merc: XY[] = ring.map((p) => toMercator(lon0 + wrapLon(p[0] - lon0), p[1]));
    const r: Rect = emptyRect();
    merc.forEach((p) => extendRect(r, p[0], p[1]));
    const shifts = [
      0,
      ...(r.maxX > WORLD / 2 ? [-WORLD] : []),
      ...(r.minX < -WORLD / 2 ? [WORLD] : [])
    ];
    for (const dx of shifts) {
      const moved: XY[] = merc.map((p) => [p[0] + dx, p[1]]);
      const box: Rect = { minX: r.minX + dx, minY: r.minY, maxX: r.maxX + dx, maxY: r.maxY };
      for (const f of index.rules.near(box)) {
        if (wanted(f) && meetsRing(f.geom, moved)) {
          out.add(f);
        }
      }
    }
  }
  return [...out];
}

/** The datum of `f`'s clearance: its own VERDAT, else its cell's, unless the cell has datum areas. */
function clearanceDatum(f: RuleFeature, cell: CellInfo | undefined): number | undefined {
  if (f.verdat !== undefined) {
    return f.verdat;
  }
  return cell?.datumAreas === undefined ? cell?.verticalDatum : undefined;
}

/**
 * How far the water may stand above the datum `f`'s clearance is given from, metres, or
 * undefined when it cannot be told: the datum is unknown, or the level is a fallback. The
 * object's own VERDAT wins over its cell's; a cell with datum areas of its own (M_VDAT, M_SDAT)
 * gives no one datum for an object that states none.
 */
function rise(
  f: RuleFeature,
  cell: CellInfo | undefined,
  hw: WaterLevel | undefined
): number | undefined {
  const vdat = clearanceDatum(f, cell);
  if (vdat === undefined) {
    return undefined;
  }
  if (HIGHEST_DATUMS.has(vdat)) {
    return 0;
  }
  if (HIGH_WATER_DATUMS.has(vdat)) {
    return HIGH_WATER_RISE;
  }
  // Heights and depths on one datum: the level above chart datum is the rise above the clearance's.
  const same = (cell?.soundingDatum ?? cell?.verticalDatum) === vdat;
  if (!same || !hw || hw.degraded !== undefined) {
    return undefined;
  }
  return Math.max(0, hw.h + 2 * hw.sigma);
}

function clearanceVerdict(
  f: RuleFeature,
  cell: CellInfo | undefined,
  needed: number,
  hw: () => WaterLevel | undefined
): RuleVerdict {
  if (f.clearance === undefined) {
    return { status: "unverified", flags: ["CLEARANCE_UNKNOWN"] };
  }
  if (f.clearance < needed) {
    return { status: "fail", flags: ["AIR_DRAFT"] };
  }
  const up = rise(f, cell, hw());
  // A rise not known is taken as UNKNOWN_RISE, never silently: the leg is marked for it.
  if (up === undefined) {
    return f.clearance - UNKNOWN_RISE < needed
      ? { status: "unverified", flags: ["CLEARANCE_UNKNOWN"] }
      : { status: "ok", flags: ["CLEARANCE_RISE_ASSUMED"] };
  }
  return f.clearance - up < needed
    ? { status: "fail", flags: ["AIR_DRAFT"] }
    : { status: "ok", flags: [] };
}

function areaVerdict(f: RuleFeature): RuleVerdict {
  const r = f.restrictions ?? [];
  if (r.includes(ENTRY_PROHIBITED)) {
    return { status: "fail", flags: ["ENTRY_PROHIBITED"] };
  }
  const flags = [
    ...(r.includes(ENTRY_RESTRICTED) ? ["ENTRY_RESTRICTED"] : []),
    ...(r.includes(TO_BE_AVOIDED) ? ["AREA_TO_BE_AVOIDED"] : [])
  ];
  return { status: "ok", flags };
}

/** The angle between two courses, 0..180 degrees. */
const apart = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

function laneVerdict(f: RuleFeature, course: number | undefined): RuleVerdict {
  if (course === undefined || f.orient === undefined) {
    return { status: "ok", flags: ["TRAFFIC_LANE"] };
  }
  const d = apart(course, f.orient);
  const along = d <= FOLLOW_DEG;
  const across = Math.abs(d - 90) <= CROSS_DEG;
  return along || across
    ? { status: "ok", flags: ["TRAFFIC_LANE"] }
    : { status: "fail", flags: ["TRAFFIC_LANE", "TSS_WRONG_WAY"] };
}

/** The rules a corridor of `rings` meets, at the window `w`. */
export function checkRules(
  index: ChartIndex,
  rings: readonly (readonly LonLat[])[],
  w: RuleWindow
): RuleVerdict {
  // A preference (a leading line, an anchorage) is the planner's: no verdict reads it. Without
  // an air height nothing overhead is read: its geometry is not tested either.
  const reads = (objectClass: string): boolean =>
    !PREFERENCES.has(objectClass) &&
    (w.airHeight !== undefined || !(OVERHEAD_CLASSES as readonly string[]).includes(objectClass));
  // An index holding no feature of a class read here meets none: the rings are not looked up.
  const found = [...index.rules.classes].some(reads)
    ? met(index, rings, (f) => reads(f.objectClass))
    : [];
  let status: RuleStatus = "ok";
  const flags = new Set<string>();
  let hw: WaterLevel | undefined;
  const highWater = (): WaterLevel | undefined => (hw ??= w.highWater?.());
  for (const f of found) {
    let v: RuleVerdict;
    if ((OVERHEAD_CLASSES as readonly string[]).includes(f.objectClass)) {
      if (w.airHeight === undefined) {
        continue;
      }
      v = clearanceVerdict(
        f,
        index.catalogue.cells[f.cellRef],
        w.airHeight + AIR_MARGIN,
        highWater
      );
    } else if (f.objectClass === "RESARE") {
      v = areaVerdict(f);
    } else if (f.objectClass === "TSSLPT") {
      v = laneVerdict(f, w.course);
    } else {
      // A preference (a leading line, an anchorage) is the planner's: no verdict reads it.
      continue;
    }
    v.flags.forEach((x) => flags.add(x));
    if (RANK[v.status] > RANK[status]) {
      status = v.status;
    }
  }
  return { status, flags: [...flags] };
}

const STATUS_RANK: Record<LegStatus, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };

/** A corridor of a route check: its rings, its window and, for a leg, its course. */
export interface RuleCorridor {
  rings: readonly (readonly LonLat[])[];
  start: number;
  end: number;
  at: readonly LonLat[];
  /** The ring is an area, a box: the level holds for every point inside it. */
  area?: boolean;
  course?: number;
}

/**
 * `status`, a corridor's depth status, made no better than its rules allow, their flags added
 * to `c.flags`: the boat's air height against what passes overhead, at the window's highest
 * water, and the rules of the areas the corridor meets.
 */
export function applyRules(
  status: LegStatus,
  c: {
    index: ChartIndex;
    input: {
      vessel: { airHeight?: number };
      highWater?(start: number, end: number, at: readonly LonLat[], area?: boolean): WaterLevel;
    };
    flags: string[];
  },
  corridor: RuleCorridor
): LegStatus {
  const high = c.input.highWater;
  const { start, end, at, area } = corridor;
  const rules = checkRules(c.index, corridor.rings, {
    airHeight: c.input.vessel.airHeight,
    ...(high && { highWater: () => high(start, end, at, area) }),
    ...(corridor.course !== undefined && { course: corridor.course })
  });
  for (const f of rules.flags) {
    if (!c.flags.includes(f)) {
      c.flags.push(f);
    }
  }
  return STATUS_RANK[rules.status] > STATUS_RANK[status] ? rules.status : status;
}
