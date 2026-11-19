import type { Bbox } from "./ingest/wfs";
import type { OnProgress, WfsRefresher } from "./wfs-service";
import type { BoxJobDeps } from "./wfs-worker";
import { refreshJob } from "./wfs-worker";
import type { Clock } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";
import { growBbox } from "./spatial/build-box";
import { MAX_CHART_BUFFER } from "./spatial/chart-position";
import { indexDirProblem } from "./spatial/chart-index";
import { EARTH_RADIUS } from "./foundation/geo";

/**
 * The planning box (signalk-route-planner's plan §4.2): an index built on request for a region
 * the chart box around the vessel does not reach, from the same cells and cell cache, in a
 * build process of its own at the lowest CPU priority, one at a time, never beside a chart box
 * build. The box around the vessel comes first: a planning build is stopped when one starts,
 * and started again once it is done. One planning index is held at a time and released once
 * unused for IDLE_MS; its files stay on disk, so the next build reuses their tiles.
 */

/** A planning index unused for this long is released, ms. */
export const IDLE_MS = 10 * 60_000;
/** How often a planning build waiting for the chart box looks again, ms. */
const WAIT_MS = 1000;
/** How often the held index is looked at for release, ms. */
const SWEEP_MS = 60_000;

const OUT_OF_MEMORY = /heap limit/;

/** A built planning index and the region its queries are judged on the charts in. */
export interface HeldBox {
  /** The region asked for: every query whose corridor lies in it reads charted tiles. */
  readonly region: Bbox;
  /** The box the index was built in: the region grown by the chart position reach. */
  readonly bbox: Bbox;
  readonly index: ChartIndex;
  /** False once released: its index is no longer the one held. */
  readonly live: boolean;
}

export type PrepareOutcome =
  { ok: true; held: HeldBox } | { ok: false; status: number; error: string };

export interface PlanningBoxDeps {
  /** Holds the planning box's Traficom WFS cell, when that source is on. */
  dir: string;
  /** The planning index's own directory, apart from the chart box's. */
  indexDir: string;
  /** The chart box service's job settings (`startWfs`), for the job of a planning box. */
  job: () => Omit<BoxJobDeps, "indexDir" | "inBox">;
  refresh: WfsRefresher;
  /** The largest planning box, km², with its reach: the chart box's area at its cap. */
  maxKm2: number;
  /** Whether a chart box build is running or about to: a planning build waits for it. */
  boxBusy: () => boolean;
  /**
   * Pauses the cell cache's filling ahead of a build, as a chart box build does; the function
   * it resolves with lets it fill again once the build has ended.
   */
  pauseWarming?: () => Promise<() => void>;
  clock: Pick<Clock, "now" | "setInterval" | "clearInterval">;
  /** Waits `ms`, rejecting once `signal` aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  debug?: (message: string) => void;
}

/** `[w, s, e, n]` with each side finite, west of east, south of north, within ±85°. */
export function regionError(r: unknown): string | undefined {
  const ok =
    Array.isArray(r) &&
    r.length === 4 &&
    r.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    (r[0] as number) >= -180 &&
    (r[2] as number) <= 180 &&
    (r[1] as number) >= -85 &&
    (r[3] as number) <= 85 &&
    (r[0] as number) < (r[2] as number) &&
    (r[1] as number) < (r[3] as number);
  return ok
    ? undefined
    : "region must be [west, south, east, north] in degrees, west < east, south < north, within ±85°";
}

/** The area of `b`, km², on a sphere. */
export function bboxKm2([w, s, e, n]: Bbox): number {
  const k = Math.PI / 180;
  const r = EARTH_RADIUS / 1000;
  return r * r * (e - w) * k * (Math.sin(n * k) - Math.sin(s * k));
}

/** Whether `outer` holds all of `inner`. */
export function holds(outer: Bbox, inner: Bbox): boolean {
  return (
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
  );
}

/** The box a planning index of `region` is built in: grown by the widest chart position reach. */
export function planningBbox(region: Bbox): Bbox {
  return growBbox(region, MAX_CHART_BUFFER / 1000);
}

function realWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

class Held implements HeldBox {
  live = true;
  usedAt: number;
  constructor(
    readonly region: Bbox,
    readonly bbox: Bbox,
    readonly index: ChartIndex,
    now: number
  ) {
    this.usedAt = now;
  }
}

interface Running {
  bbox: Bbox;
  done: Promise<PrepareOutcome | "again">;
  controller: AbortController;
  /** Set when the chart box took the build process: the build is started again after it. */
  preempted: boolean;
}

export class PlanningBoxes {
  private held: Held | undefined;
  private running: Running | undefined;
  private maxKm2: number;
  private stopped = false;
  private readonly sweep: unknown;

  constructor(private readonly deps: PlanningBoxDeps) {
    this.maxKm2 = deps.maxKm2;
    this.sweep = deps.clock.setInterval(() => this.releaseIdle(), SWEEP_MS);
  }

  /** The planning index held now, if any. */
  current(): HeldBox | undefined {
    return this.held;
  }

  /** Whether a planning build is running. */
  building(): boolean {
    return this.running !== undefined;
  }

  /** Marks `held` used now, so it is not released while a plan reads it. */
  touch(held: HeldBox): void {
    if (held === this.held) {
      this.held.usedAt = this.deps.clock.now();
    }
  }

  /**
   * A planning index whose queries are judged on the charts across `region`: the one held when
   * it covers the region, else one built for it. Waits for a chart box build to finish first,
   * and starts again after one that took over. Resolves with an error status when the region is
   * too large (413), the index directory refuses a commit or the build fails (503), or `signal`
   * aborts (503).
   */
  async prepare(region: Bbox, signal: AbortSignal, progress?: OnProgress): Promise<PrepareOutcome> {
    const bbox = planningBbox(region);
    const km2 = bboxKm2(bbox);
    if (km2 > this.maxKm2) {
      return {
        ok: false,
        status: 413,
        error: `the planning box would be ${Math.round(km2)} km² with its reach; at most ${Math.round(this.maxKm2)} km² on this machine`
      };
    }
    const wait = this.deps.wait ?? realWait;
    for (;;) {
      if (this.stopped) {
        return { ok: false, status: 503, error: "plugin stopped" };
      }
      if (signal.aborted) {
        return { ok: false, status: 503, error: "planning box request aborted" };
      }
      const held = this.held;
      if (held && holds(held.region, region)) {
        held.usedAt = this.deps.clock.now();
        return { ok: true, held };
      }
      const running = this.running;
      try {
        if (running) {
          await Promise.race([running.done, abortOf(signal)]);
        } else if (this.deps.boxBusy()) {
          await wait(WAIT_MS, signal);
        } else {
          const r = await this.build(region, bbox, signal, progress);
          if (r !== "again") {
            return r;
          }
        }
      } catch {
        // Aborted: the loop says so.
      }
    }
  }

  /**
   * Stops a running planning build so a chart box build can run; resolves once its process
   * has exited. The planning build starts again once the chart box is built.
   */
  async preempt(): Promise<void> {
    const r = this.running;
    if (!r) {
      return;
    }
    r.preempted = true;
    r.controller.abort(new Error("the chart box around the vessel is being built"));
    await r.done.catch(() => undefined);
  }

  /** Releases the held index and stops any build; no build starts after it. */
  stop(): void {
    this.stopped = true;
    this.deps.clock.clearInterval(this.sweep);
    this.release();
    this.running?.controller.abort(new Error("plugin stopped"));
  }

  /** Releases the held index: its handles answer that it is gone. */
  release(): void {
    if (this.held) {
      this.held.live = false;
      this.held = undefined;
    }
  }

  private releaseIdle(): void {
    const h = this.held;
    if (h && this.deps.clock.now() - h.usedAt >= IDLE_MS) {
      this.deps.debug?.("planning box released after it went unused");
      this.release();
    }
  }

  private build(
    region: Bbox,
    bbox: Bbox,
    signal: AbortSignal,
    progress?: OnProgress
  ): Promise<PrepareOutcome | "again"> {
    const problem = indexDirProblem(this.deps.indexDir);
    if (problem !== undefined) {
      return Promise.resolve({ ok: false, status: 503, error: `planning box: ${problem}` });
    }
    const controller = new AbortController();
    const stopIt = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", stopIt, { once: true });
    const run: Running = { bbox, controller, preempted: false, done: Promise.resolve("again") };
    // The index it replaces is never read again: its files are about to be replaced.
    this.release();
    const started = this.deps.clock.now();
    run.done = (async (): Promise<PrepareOutcome | "again"> => {
      let resume: (() => void) | undefined;
      try {
        resume = await this.deps.pauseWarming?.();
        const job = refreshJob(
          { ...this.deps.job(), indexDir: this.deps.indexDir, inBox: true },
          this.deps.dir,
          bbox,
          started
        );
        const { index } = await this.deps.refresh(
          { ...job, lowPriority: true },
          controller.signal,
          progress
        );
        if (controller.signal.aborted) {
          return run.preempted ? "again" : aborted();
        }
        const held = new Held(region, bbox, index, this.deps.clock.now());
        this.held = held;
        this.deps.debug?.(
          `planning box built in ${Math.round((this.deps.clock.now() - started) / 1000)} s`
        );
        return { ok: true, held };
      } catch (err) {
        if (run.preempted && !signal.aborted && !this.stopped) {
          return "again";
        }
        if (controller.signal.aborted) {
          return aborted();
        }
        const message = (err as Error).message;
        if (OUT_OF_MEMORY.test(message)) {
          // Not tried at that size again in this run.
          this.maxKm2 = Math.min(this.maxKm2, bboxKm2(bbox) * 0.5);
        }
        return { ok: false, status: 503, error: `planning box build failed: ${message}` };
      } finally {
        signal.removeEventListener("abort", stopIt);
        if (this.running === run) {
          this.running = undefined;
        }
        if (!run.preempted && !this.stopped) {
          resume?.();
        }
      }
    })();
    this.running = run;
    return run.done;
  }
}

function aborted(): PrepareOutcome {
  return { ok: false, status: 503, error: "planning box request aborted" };
}

/** Rejects once `signal` aborts; never resolves. */
function abortOf(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
