import type { ServerAPI } from "@signalk/server-api";
import type { LookaheadOptions, Sample } from "./engine/lookahead";
import { NOTIFY_REFRESH_MS } from "./engine/notify";
import { PILOT_MIN_BUFFER, roomOf } from "./engine/pilotage";
import type { PilotageVerdict, WatchedLeg } from "./engine/pilotage-watch";
import { legAt, pilotageVerdict } from "./engine/pilotage-watch";
import type { LonLat } from "./foundation/geo";
import { PATHS } from "./foundation/state";
import type { FixHistoryStore } from "./fix-history-store";
import type { FixHistory } from "./model/fix-history";
import type { IntegrityResult } from "./model/integrity";
import type { Monitor } from "./monitor";
import { ChangeNotifier } from "./notifications";
import type { ChartIndex } from "./spatial/chart-index";

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
  return m ? decodeURIComponent(m[1] as string) : undefined;
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

export class PilotageWatch {
  private href?: string;
  private legs: (WatchedLeg & { measured: boolean })[] = [];
  private index?: ChartIndex;

  constructor(
    private readonly app: App,
    private readonly onError: (message: string) => void = () => undefined
  ) {}

  /**
   * The verdict at `position` on the active route, for the live buffer `need` (undefined when
   * the fix cannot be trusted), with `least` the planning buffer the room is measured up to; none
   * when no route is active, the boat is off it, or the leg it is on is not swept water narrower
   * than `least`.
   */
  check(
    index: ChartIndex | undefined,
    position: LonLat | undefined,
    need: number | undefined,
    least: number
  ): PilotageVerdict | undefined {
    this.follow();
    if (!index || !position || this.legs.length === 0) {
      return undefined;
    }
    if (index !== this.index) {
      // Another chart index: every room is measured again on it.
      this.index = index;
      this.legs = this.legs.map((l) => ({ from: l.from, to: l.to, measured: false }));
    }
    const i = legAt(position, this.legs);
    const leg = i === undefined ? undefined : this.legs[i];
    if (i === undefined || !leg) {
      return undefined;
    }
    if (!leg.measured && PILOT_MIN_BUFFER < least) {
      const room = roomOf(index, [leg.from, leg.to], 0, [PILOT_MIN_BUFFER, least]);
      leg.measured = true;
      if (room !== undefined) {
        leg.room = room;
      }
    }
    return leg.room === undefined || leg.room >= least
      ? undefined
      : pilotageVerdict(i, leg.room, need);
  }

  /** Loads the active route's legs when the course API names another one. */
  private follow(): void {
    const href = activeHref(this.app);
    if (href === this.href) {
      return;
    }
    this.href = href;
    this.legs = [];
    const id = routeIdOf(href);
    if (id === undefined) {
      return;
    }
    this.app.resourcesApi
      .getResource("routes", id)
      .then((r) => {
        const c = this.href === href ? routeCoordinates(r) : undefined;
        if (c) {
          this.legs = c.slice(1).map((to, k) => ({ from: c[k] as LonLat, to, measured: false }));
        }
      })
      .catch((err: Error) => this.onError(`active route ${id}: ${err.message}`));
  }
}

/** What the pilotage service reads at each position. */
export interface PilotageTick {
  integrity?: IntegrityResult;
  index?: ChartIndex;
  position?: Sample<LonLat>;
  now: number;
}

/**
 * The fix quality a plan is checked at and the live fix held to it, at each position the monitor
 * takes in: the fix's measured σ goes into the history (`model/fix-history.ts`) while the
 * position is fresh, and the pilotage notification follows the active route's swept legs.
 */
export class PilotageService {
  readonly watch: PilotageWatch;
  private readonly notifier: ChangeNotifier;
  private saveFailed = false;

  constructor(
    readonly fixes: FixHistoryStore,
    app: App & Pick<ServerAPI, "handleMessage">,
    pluginId: string,
    private readonly lookahead: () => LookaheadOptions,
    private readonly onError: (message: string) => void
  ) {
    this.watch = new PilotageWatch(app, onError);
    this.notifier = new ChangeNotifier(app, pluginId);
  }

  get history(): FixHistory {
    return this.fixes.history;
  }

  /** Runs at each position `monitor` takes in, on the index `index` gives. */
  attach(monitor: Monitor, index: () => ChartIndex | undefined, now: () => number): void {
    monitor.watch(["navigation.position"], () =>
      this.tick({
        integrity: monitor.integrityResult,
        index: index(),
        position: monitor.nav.position,
        now: now()
      })
    );
  }

  tick(t: PilotageTick): void {
    const l = this.lookahead();
    const p = t.position;
    const fresh = p && t.now - p.at <= l.staleAfter * 1000 ? p.value : undefined;
    if (t.integrity && fresh) {
      this.fixes.history.add(t.integrity.sigmaPos, t.now);
      this.save(t.now, false);
    }
    // A failing integrity check leaves no buffer the fix can be trusted to.
    const need = t.integrity?.ok ? l.kp * t.integrity.sigmaPos : undefined;
    const v = this.watch.check(t.index, fresh, need, l.positionBuffer);
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

  /** Clears the notification and saves the history: the plugin stops. */
  stop(now: number): void {
    this.notifier.clear(PATHS.pilotage, "UKC monitoring stopped");
    this.save(now, true);
  }

  /** Saves the history when due; a disk that refuses it is reported once. */
  private save(now: number, force: boolean): void {
    try {
      this.fixes.save(now, force);
    } catch (err) {
      if (!this.saveFailed) {
        this.saveFailed = true;
        this.onError(`fix history not saved: ${(err as Error).message}`);
      }
    }
  }
}
