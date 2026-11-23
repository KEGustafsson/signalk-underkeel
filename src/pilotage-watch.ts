import type { ServerAPI } from "@signalk/server-api";
import type { LookaheadOptions, Sample } from "./engine/lookahead";
import { NOTIFY_REFRESH_MS } from "./engine/notify";
import { roomOf } from "./engine/room";
import type { PilotageVerdict, WatchedLeg } from "./engine/pilotage-watch";
import { legAt, pilotageVerdict } from "./engine/pilotage-watch";
import type { LonLat } from "./foundation/geo";
import { PATHS } from "./foundation/state";
import type { IntegrityResult } from "./model/integrity";
import type { Monitor } from "./monitor";
import { ChangeNotifier } from "./notifications";
import type { ChartIndex } from "./spatial/chart-index";
import { FALLBACK_HULL, hullBuffer } from "./model/vessel";

/**
 * The active route's legs, read through the Signal K course API (`navigation.course.activeRoute`)
 * and the route resource it names, each leg's room found on the chart index in use the first
 * time the boat is on it (`engine/pilotage-watch.ts`). Any active route is watched, planned by
 * the route planner or drawn by hand: the room is the chart's, not the planner's.
 */

type App = Pick<ServerAPI, "getSelfPath" | "resourcesApi">;

/** The route id an `href` such as `/resources/routes/<id>` names. */
export function routeIdOf(href: unknown): string | undefined {
  if (typeof href !== "string") {
    return undefined;
  }
  const m = /\/resources\/routes\/([^/?#]+)$/.exec(href);
  if (!m) {
    return undefined;
  }
  try {
    return decodeURIComponent(m[1] as string);
  } catch {
    return undefined;
  }
}

/** The coordinates of a route resource, or none when it holds no line. */
export function routeCoordinates(resource: unknown): LonLat[] | undefined {
  const g = (resource as { feature?: { geometry?: { type?: unknown; coordinates?: unknown } } })
    ?.feature?.geometry;
  if (g?.type !== "LineString" || !Array.isArray(g.coordinates)) {
    return undefined;
  }
  const c = g.coordinates.filter(
    (p): p is LonLat =>
      Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  return c.length >= 2 ? c.map((p) => [p[0], p[1]] as LonLat) : undefined;
}

/** The `href` of the active route, from the course API's value as the self model holds it. */
function activeHref(app: App): string | undefined {
  const node = app.getSelfPath("navigation.course.activeRoute") as
    { value?: { href?: unknown }; href?: unknown } | null | undefined;
  const href = node?.value?.href ?? node?.href;
  return typeof href === "string" ? href : undefined;
}

/** How long after a failed load the active route is asked for again, ms. */
export const ROUTE_RETRY_MS = 30_000;

export class PilotageWatch {
  private href?: string;
  /** Counts the loads started: only the latest one's answer is taken. */
  private generation = 0;
  /** When the active route is asked for again after its load failed. */
  private retryAt?: number;
  private legs: (WatchedLeg & { measured: boolean })[] = [];
  private index?: ChartIndex;
  private hull?: number;

  constructor(
    private readonly app: App,
    private readonly onError: (message: string) => void = () => undefined
  ) {}

  /**
   * The verdict at `position` on the active route, for the live buffer `need` (undefined when
   * the fix cannot be trusted), the room measured past `hull`, the hull's half-beam, up to
   * `least`, the look-ahead's least position buffer; none when no route is active, the boat is
   * off it, or the leg it is on is not swept water narrower than `least` past the hull.
   */
  check(
    index: ChartIndex | undefined,
    position: LonLat | undefined,
    need: number | undefined,
    c: { least: number; hull: number },
    now = Date.now()
  ): PilotageVerdict | undefined {
    this.follow(now);
    if (!index || !position || this.legs.length === 0) {
      return undefined;
    }
    if (index !== this.index || c.hull !== this.hull) {
      // Another chart index or hull: every room is measured again.
      this.index = index;
      this.hull = c.hull;
      this.legs = this.legs.map((l) => ({ from: l.from, to: l.to, measured: false }));
    }
    const least = c.least;
    const i = legAt(position, this.legs);
    const leg = i === undefined ? undefined : this.legs[i];
    if (i === undefined || !leg) {
      return undefined;
    }
    if (!leg.measured && least > 0) {
      const room = roomOf(index, [leg.from, leg.to], c.hull, [0, least]);
      leg.measured = true;
      if (room !== undefined) {
        leg.room = room;
      }
    }
    return leg.room === undefined || leg.room >= least
      ? undefined
      : pilotageVerdict(i, leg.room, need);
  }

  /**
   * Loads the active route's legs when the course API names another one, or ROUTE_RETRY_MS after
   * its load failed.
   */
  private follow(now: number): void {
    const href = activeHref(this.app);
    if (href === this.href && (this.retryAt === undefined || now < this.retryAt)) {
      return;
    }
    this.href = href;
    this.retryAt = undefined;
    this.legs = [];
    const generation = ++this.generation;
    const id = routeIdOf(href);
    if (id === undefined) {
      return;
    }
    this.app.resourcesApi
      .getResource("routes", id)
      .then((r) => {
        const c = generation === this.generation ? routeCoordinates(r) : undefined;
        if (c) {
          this.legs = c.slice(1).map((to, k) => ({ from: c[k] as LonLat, to, measured: false }));
        }
      })
      .catch((err: unknown) => {
        if (generation === this.generation) {
          this.retryAt = now + ROUTE_RETRY_MS;
          this.onError(`active route ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
  }
}

/** What the pilotage service reads after each of the monitor's ticks. */
export interface PilotageTick {
  integrity?: IntegrityResult;
  index?: ChartIndex;
  position?: Sample<LonLat>;
  /** The hull's half-beam, metres (`model/vessel.ts`, `hullBuffer`). */
  hull: number;
  now: number;
}

/**
 * The live fix held to the active route's swept legs, after each of the monitor's ticks, on the
 * position and integrity check of that tick: the pilotage notification follows the leg the boat
 * is on (`engine/pilotage-watch.ts`). A plan never reads the fix; this is the one place it counts.
 */
export class PilotageService {
  readonly watch: PilotageWatch;
  private readonly notifier: ChangeNotifier;

  constructor(
    app: App & Pick<ServerAPI, "handleMessage">,
    pluginId: string,
    private readonly lookahead: () => LookaheadOptions,
    onError: (message: string) => void
  ) {
    this.watch = new PilotageWatch(app, onError);
    this.notifier = new ChangeNotifier(app, pluginId);
  }

  /** Runs after each of `monitor`'s ticks, on the index `index` gives. */
  attach(monitor: Monitor, index: () => ChartIndex | undefined, now: () => number): void {
    monitor.afterTick = () => {
      this.tick({
        integrity: monitor.integrityResult,
        index: index(),
        position: monitor.nav.position,
        hull: hullBuffer(monitor.vessel() ?? FALLBACK_HULL),
        now: now()
      });
    };
  }

  tick(t: PilotageTick): void {
    const l = this.lookahead();
    const p = t.position;
    const fresh = p && t.now - p.at <= l.staleAfter * 1000 ? p.value : undefined;
    // A failing integrity check leaves no buffer the fix can be trusted to.
    const need = t.integrity?.ok ? l.kp * t.integrity.sigmaPos : undefined;
    const v = this.watch.check(
      t.index,
      fresh,
      need,
      { least: l.positionBuffer, hull: t.hull },
      t.now
    );
    if (!v) {
      this.notifier.clear(PATHS.pilotage, "Pilotage: no swept leg of the active route here");
      return;
    }
    const warn = v.state === "warn";
    // Sent at once when the state, the leg or whether the fix is trusted changes; the numbers in
    // the message, which change with every fix, at most every NOTIFY_REFRESH_MS.
    const key = `${v.state}|${v.data.leg}|${v.data.need === null ? "untrusted" : "fix"}`;
    this.notifier.send(
      PATHS.pilotage,
      { state: v.state, method: warn ? ["visual", "sound"] : [], message: v.message, data: v.data },
      { key, refreshMs: NOTIFY_REFRESH_MS, now: t.now }
    );
  }

  /** Clears the notification: the plugin stops. */
  stop(): void {
    this.notifier.clear(PATHS.pilotage, "UKC monitoring stopped");
  }
}
