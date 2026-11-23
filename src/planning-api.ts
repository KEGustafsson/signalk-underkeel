import { LIMITS } from "./api/route-request";
import type { ApiReply } from "./api/routes";
import { checkFootprint, checkLeg } from "./engine/route-check";
import { areaKm2, grownBox } from "./planning-geometry";
import type { RouteCheckInput } from "./engine/route-check";
import type { LonLat } from "./foundation/geo";
import { EARTH_RADIUS, haversine } from "./foundation/geo";
import type { Bbox } from "./ingest/wfs";
import type { HeldBox, PlanningBoxes } from "./planning-box";
import { carryAdjustments, holds, regionError } from "./planning-box";
import { type ChartObject, sessionObjects } from "./planning-objects";
import type { RouteQueue, RouteServiceDeps } from "./route-service";
import { routeCheck, vesselFor } from "./route-service";
import { heldBox } from "./engine/held-box";
import { FALLBACK_HULL, hullBuffer } from "./model/vessel";
import type { SurveyResult } from "./planning-survey";
import { corridorError, surveyOver } from "./planning-survey";
import { growBbox } from "./spatial/build-box";
import { MAX_CHART_BUFFER } from "./spatial/chart-position";

/**
 * Planning API v1: the in-process interface signalk-route-planner searches against
 * (its docs/DEVELOPMENT-PLAN.md §2.1). Both plugins run in the Signal K server's Node
 * process; this one registers the object under `PLANNING_API` while it runs, so the
 * planner reads this index, water level and vessel instead of building its own.
 */

export const PLANNING_API = Symbol.for("signalk-underkeel.planning");

export type { ChartObject } from "./planning-objects";

export type Status = "ok" | "marginal" | "fail" | "unverified";

export interface Verdict {
  status: Status;
  risk: number;
  flags: string[];
  worst?: LonLat;
}

export interface Window {
  start: number;
  end: number;
}

export interface SessionParams {
  /** Epoch ms. */
  departure: number;
  /** End of the window the verdicts hold for, epoch ms. */
  until: number;
  /** m/s. */
  speed: number;
  xteLimit?: number;
  probability?: number;
  draft?: number;
  /** Air height, metres, in place of the vessel's: bridges and overhead cables are held to it. */
  airHeight?: number;
  /** Significant wave height to allow for, metres; absent, the configured planned value. */
  waveHeight?: number;
}

export interface Session {
  /** Corridor half-width: xteLimit + the hull's half-beam, metres. */
  readonly halfWidth: number;
  /** Every point of the box with halfWidth around it, at the lowest level in the window. */
  box(sw: LonLat, ne: LonLat, window?: Window): Verdict;
  /**
   * The leg a → b, checked as /route-check checks a leg, over the window. A leg whose
   * corridor (length plus both ends, times twice halfWidth) is over 25 km² throws RangeError.
   */
  segment(a: LonLat, b: LonLat, window?: Window): Verdict;
  /** The chart objects whose bounds meet the box sw–ne, in this session's index. */
  objects(sw: LonLat, ne: LonLat): ChartObject[];
  /** Work done so far, in work units (src/engine/work.ts). */
  work(): number;
  /** Yields to the event loop; rejects once the request is aborted. */
  pause(): Promise<void>;
}

export type SessionResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string };

/**
 * An index prepared for a region (`prepare`): the chart box around the vessel when it covers
 * the region, the whole index when there is no box, else a planning box built for it.
 */
export interface Prepared {
  /** The box the index was built in [west, south, east, north]; undefined for a whole index. */
  readonly coverage: Bbox | undefined;
  /** `session` over this index. */
  session<T>(
    params: SessionParams,
    signal: AbortSignal,
    job: (s: Session) => Promise<T>
  ): Promise<SessionResult<T>>;
  /** `routeCheck` over this index. */
  routeCheck(body: unknown, signal: AbortSignal): Promise<ApiReply>;
  /** Frees a planning box early; its sessions then answer 503. Nothing for the other kinds. */
  release(): void;
}

export type { Survey } from "./survey";
export type { SurveyResult } from "./planning-survey";

export type PrepareResult =
  { ok: true; value: Prepared } | { ok: false; status: number; error: string };

/** What this provider adds to version 1, for a planner to test before it calls it. */
export const FEATURES = ["prepare", "corridor", "survey", "objects"] as const;

export interface PlanningApiV1 {
  readonly version: 1;
  /** The underkeel release serving it. */
  readonly provider: string;
  /** Additions to version 1 this provider serves (`FEATURES`); a planner tests it before use. */
  readonly features: readonly string[];
  /** Why planning cannot run now; undefined when the index is ready. */
  unavailable(): string | undefined;
  /** The box the index covers [west, south, east, north]; undefined for a whole index. */
  coverage(): [number, number, number, number] | undefined;
  /**
   * The route check's settings, and `draft`: the vessel's draft as a session without one takes
   * it (the configured draft, else Signal K `design.draft.maximum`); absent while none is known.
   */
  defaults(): {
    speed: number;
    xteLimit: number;
    probability: number;
    planningBuffer: number;
    draft?: number;
  };
  /** Runs `job` with the index, in the request queue route checks run in. */
  session<T>(
    params: SessionParams,
    signal: AbortSignal,
    job: (s: Session) => Promise<T>
  ): Promise<SessionResult<T>>;
  /** The `/route-check` service: same body, same reply. */
  routeCheck(body: unknown, signal: AbortSignal): Promise<ApiReply>;
  /**
   * An index whose queries are judged on the charts wherever a box's or leg's corridor lies in
   * `region` [west, south, east, north]: the index in use when it covers the region, else a
   * planning box built for it (`planning-box.ts`). A build can take minutes; it runs behind the
   * chart box around the vessel. 400 for a bad region, 413 for one too large to build on this
   * machine, 503 when no index or build is to be had.
   *
   * With `corridor` (feature "corridor"), boxes within `region` it is cut into, no two
   * overlapping: an index whose queries are judged on the charts where their corridor lies in
   * the boxes. A planning box built for them holds their Traficom WFS depths alone, its memory
   * going with their area, and past them reads no coverage; S-57 cells in use are built across
   * its whole box. An index already held that covers every box (the index in use, or a planning
   * box built for a region) is given instead, and judges on the charts across all it holds.
   */
  prepare(region: Bbox, signal: AbortSignal, corridor?: readonly Bbox[]): Promise<PrepareResult>;
  /**
   * The depth survey of `region` (feature "survey", `survey.ts`): cells about `cellMetres` on a
   * side, or coarser, each the deepest and the shallowest charted depth touching it. Made tile by tile in the
   * build process, so it may cover far more than a planning box. It is for choosing a
   * corridor, never a verdict. 400 for a bad request, 413 too large, 501 without a source it
   * can survey, 503 when it fails.
   */
  survey?(region: Bbox, cellMetres: number, signal: AbortSignal): Promise<SurveyResult>;
}

/**
 * A box's area with its buffer, and a leg's corridor, may be at most this, km²: their
 * queries run without a pause and cost about their area.
 */
export const MAX_BOX_KM2 = 25;

export { greatCircleBulge, grownBox } from "./planning-geometry";

function pauseFor(signal: AbortSignal): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) =>
      setImmediate(() => (signal.aborted ? reject(signal.reason) : resolve()))
    );
}

const within = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Why `p` cannot start a session, or undefined: the same bounds `/route-check`
 * holds a request to, applied to the values the session would score with.
 */
export function paramsError(
  p: SessionParams,
  probability: number,
  xteLimit: number
): string | undefined {
  if (!Number.isFinite(p.departure) || !Number.isFinite(p.until) || p.until < p.departure) {
    return "departure and until must be finite epoch ms, until not before departure";
  }
  if (!within(p.speed, LIMITS.minSpeed, LIMITS.maxSpeed)) {
    return `speed must be ${LIMITS.minSpeed}..${LIMITS.maxSpeed} m/s`;
  }
  if (!within(xteLimit, 0, LIMITS.maxXte)) {
    return `xteLimit must be 0..${LIMITS.maxXte} m`;
  }
  if (!within(probability, LIMITS.minProbability, LIMITS.maxProbability)) {
    return `probability must be ${LIMITS.minProbability}..${LIMITS.maxProbability}`;
  }
  if (p.draft !== undefined && !within(p.draft, LIMITS.minDraft, LIMITS.maxDraft)) {
    return `draft must be ${LIMITS.minDraft}..${LIMITS.maxDraft} m`;
  }
  if (p.airHeight !== undefined && !within(p.airHeight, LIMITS.minAirHeight, LIMITS.maxAirHeight)) {
    return `airHeight must be ${LIMITS.minAirHeight}..${LIMITS.maxAirHeight} m`;
  }
  if (p.waveHeight !== undefined && !within(p.waveHeight, 0, LIMITS.maxWaveHeight)) {
    return `waveHeight must be 0..${LIMITS.maxWaveHeight} m`;
  }
  return undefined;
}

function inputFor(deps: RouteServiceDeps, p: SessionParams): RouteCheckInput | string {
  const vessel = vesselFor(p, deps);
  if (!vessel) {
    return "vessel draft not configured";
  }
  return {
    coordinates: [],
    departure: p.departure,
    speeds: [p.speed],
    xteLimit: p.xteLimit ?? deps.config.routeCheck.xteLimit,
    hullBuffer: hullBuffer(vessel),
    vessel,
    dynamics: deps.config.dynamics,
    waterLevel: deps.waterLevel,
    ...(deps.highWater && { highWater: deps.highWater }),
    // A planned wave height, never the sensor's: the route is sailed later and elsewhere.
    waveHeight: p.waveHeight ?? deps.config.routeCheck.waveHeight,
    probability: p.probability ?? deps.config.routeCheck.probability
  };
}

/** A session over the index in use; its verdicts hold for every instant in `window`. */
function sessionFor(
  deps: RouteServiceDeps,
  index: NonNullable<RouteServiceDeps["index"]>,
  input: RouteCheckInput,
  p: SessionParams,
  signal: AbortSignal
): Session {
  const halfWidth = input.xteLimit + input.hullBuffer;
  const whole: Window = { start: p.departure, end: p.until };
  let work = 0;
  return {
    halfWidth,
    box(sw, ne, window = whole) {
      const ring = grownBox(sw, ne, halfWidth);
      if (areaKm2(ring) > MAX_BOX_KM2) {
        throw new RangeError(`box over ${MAX_BOX_KM2} km² with its buffer`);
      }
      const v = heldBox(index, input, ring, p.speed, window);
      work += v.work;
      return { status: v.status, risk: v.risk, flags: v.flags, worst: v.worst };
    },
    segment(a, b, window = whole) {
      // Its corridor queries run without a pause, so a leg is bounded as a box is.
      if (((haversine(a, b) + 2 * halfWidth) * 2 * halfWidth) / 1e6 > MAX_BOX_KM2) {
        throw new RangeError(`leg corridor over ${MAX_BOX_KM2} km²`);
      }
      // The leg's own level is the window's lowest, whatever its arrival time.
      const high = deps.highWater;
      const leg = {
        ...input,
        coordinates: [a, b],
        waterLevel: () => level(window, [a, b]),
        // The leg's clearances at the window's highest water, whatever its arrival time.
        ...(high && { highWater: () => high(window.start, window.end, [a, b]) })
      };
      const c = checkLeg(index, leg, 0, window.start);
      work += c.work;
      return {
        status: c.leg.status,
        risk: c.leg.risk,
        flags: c.leg.flags,
        worst: c.leg.worst?.position
      };
    },
    objects: (sw, ne) =>
      sessionObjects(index, deps.ownTracks?.() ?? [], sw, ne, (at) => level(whole, at)),
    work: () => work,
    pause: pauseFor(signal)
  };
  function level(window: Window, at: readonly LonLat[]) {
    return deps.waterLevel(window.start, window.end, at);
  }
}

/** `session` over the index `deps` gives at admission. */
function sessionOver(deps: () => RouteServiceDeps): PlanningApiV1["session"] {
  return async (params, signal, job) => {
    const d = deps();
    if (!d.index) {
      return { ok: false, status: 503, error: d.indexReason ?? "no chart index loaded" };
    }
    // One copy at admission: the job, after its wait in the queue, uses the values checked.
    const p = { ...params };
    const bad = paramsError(
      p,
      p.probability ?? d.config.routeCheck.probability,
      p.xteLimit ?? d.config.routeCheck.xteLimit
    );
    if (bad) {
      return { ok: false, status: 400, error: bad };
    }
    const input = inputFor(d, p);
    if (typeof input === "string") {
      return { ok: false, status: 422, error: input };
    }
    const index = d.index;
    const scoped = AbortSignal.any([signal, d.queue.stopSignal]);
    let value: { v: Awaited<ReturnType<typeof job>> } | undefined;
    const reply = await d.queue.run(scoped, async (s) => {
      value = { v: await job(sessionFor(d, index, input, p, s)) };
      return { status: 200, body: null };
    });
    return value && reply.status === 200
      ? { ok: true, value: value.v }
      : { ok: false, status: reply.status, error: errorOf(reply) };
  };
}

/** `box` less the band inside its edge where a query still reads past it. */
const inside = (box: Bbox): Bbox => growBbox(box, -MAX_CHART_BUFFER / 1000);

/** Whether the chart box `box` judges every query in `region` on the charts. */
const boxHolds = (box: Bbox, region: Bbox): boolean => {
  const b = inside(box);
  return b[0] < b[2] && b[1] < b[3] && holds(b, region);
};

/** The box the index in use was built in: the box service's, else the one saved with it. */
const boxOf = (d: RouteServiceDeps): Bbox | undefined => d.chartBox?.() ?? d.indexBox?.();

/** The route services over the index in use, while its box still covers `region`. */
function onIndexInUse(deps: () => RouteServiceDeps, region: Bbox, box: Bbox | undefined) {
  return (): RouteServiceDeps => {
    const d = deps();
    const now = boxOf(d);
    if (box !== undefined && !(now !== undefined && boxHolds(now, region))) {
      return {
        ...d,
        index: undefined,
        indexReason: "the chart box around the vessel no longer covers the region; prepare it again"
      };
    }
    return d;
  };
}

const refused = (error: string): ApiReply => ({ status: 503, body: { errors: [error] } });

/**
 * The route services over the planning box `held`. Each queued job, at its turn and before it
 * reads anything, takes the living chart's adjustments as they are then (invariant 5) and is
 * counted on `held`, so a new planning build waits for it before it replaces the files; a job
 * whose turn comes after the box was released is refused. Water levels relate to the planning
 * box's own cells' datums.
 */
function onPlanningBox(deps: () => RouteServiceDeps, held: HeldBox, boxes: PlanningBoxes) {
  return (): RouteServiceDeps => {
    const d = deps();
    if (!held.live) {
      return { ...d, index: undefined, indexReason: RELEASED };
    }
    boxes.touch(held);
    const cells = held.index.catalogue.cells;
    const queue: RouteQueue = {
      get stopSignal() {
        return d.queue.stopSignal;
      },
      run: (signal, job) =>
        d.queue.run(signal, async (s) => {
          const main = deps().index;
          if (!held.begin()) {
            return refused(RELEASED);
          }
          try {
            if (!main) {
              return refused(deps().indexReason ?? "no chart index loaded");
            }
            if (!carryAdjustments(main, held.index)) {
              return refused("the living chart's soundings cannot be carried to the planning box");
            }
            return await job(s);
          } finally {
            held.end();
          }
        })
    };
    return {
      ...d,
      index: held.index,
      chartBox: () => held.bbox,
      waterLevel: d.waterLevelFor?.(cells) ?? d.waterLevel,
      ...(d.highWater && { highWater: d.highWaterFor?.(cells) ?? d.highWater }),
      queue
    };
  };
}

const RELEASED = "the planning box was released; prepare it again";

function preparedOver(
  deps: () => RouteServiceDeps,
  coverage: Bbox | undefined,
  release: () => void
): Prepared {
  return {
    coverage,
    session: sessionOver(deps),
    routeCheck: (body, signal) => routeCheck(body, deps(), signal),
    release
  };
}

export function planningApi(
  deps: () => RouteServiceDeps,
  provider: string,
  boxes: () => PlanningBoxes | undefined = () => undefined
): PlanningApiV1 {
  return {
    version: 1,
    provider,
    features: FEATURES,
    unavailable: () => {
      const d = deps();
      return d.index ? undefined : (d.indexReason ?? "no chart index loaded");
    },
    coverage: () => deps().chartBox?.(),
    defaults: () => {
      const d = deps();
      const c = d.config;
      const vessel = d.vessel();
      return {
        speed: c.routeCheck.speed,
        xteLimit: c.routeCheck.xteLimit,
        probability: c.routeCheck.probability,
        // Named for the contract: the hull's half-beam, the corridor past the cross-track limit.
        planningBuffer: hullBuffer(vessel ?? FALLBACK_HULL),
        ...(vessel && { draft: vessel.draft })
      };
    },
    session: sessionOver(deps),
    routeCheck: (body, signal) => routeCheck(body, deps(), signal),
    survey: surveyOver(boxes),
    async prepare(region, signal, corridor) {
      const bad =
        regionError(region) ??
        (corridor === undefined ? undefined : corridorError(region, corridor));
      if (bad) {
        return { ok: false, status: 400, error: bad };
      }
      if (signal.aborted) {
        return { ok: false, status: 503, error: "planning box request aborted" };
      }
      const r: Bbox = [region[0], region[1], region[2], region[3]];
      const d = deps();
      if (!d.index) {
        return { ok: false, status: 503, error: d.indexReason ?? "no chart index loaded" };
      }
      const box = boxOf(d);
      if (box === undefined || boxHolds(box, r)) {
        return { ok: true, value: preparedOver(onIndexInUse(deps, r, box), box, () => undefined) };
      }
      const b = boxes();
      if (!b) {
        return {
          ok: false,
          status: 503,
          error:
            "the region lies outside the chart box around the vessel, and no planning box can be built"
        };
      }
      const parts = corridor?.map((p): Bbox => [p[0], p[1], p[2], p[3]]);
      const got = await b.prepare(r, signal, undefined, parts);
      if (!got.ok) {
        return got;
      }
      const { held } = got;
      const release = (): void => {
        if (b.current() === held) {
          b.release();
        }
      };
      return { ok: true, value: preparedOver(onPlanningBox(deps, held, b), held.bbox, release) };
    }
  };
}

function errorOf(reply: ApiReply): string {
  const errors = (reply.body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) && typeof errors[0] === "string" ? errors[0] : "planning failed";
}

type Registry = Record<symbol, PlanningApiV1 | undefined>;

/** Publishes `api` under PLANNING_API; the returned function removes it if it is still ours. */
export function registerPlanningApi(api: PlanningApiV1): () => void {
  const g = globalThis as unknown as Registry;
  g[PLANNING_API] = api;
  return () => {
    if (g[PLANNING_API] === api) {
      delete g[PLANNING_API];
    }
  };
}
