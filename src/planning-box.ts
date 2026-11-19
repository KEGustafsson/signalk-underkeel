import fs from "fs";
import path from "path";
import type { Bbox } from "./ingest/wfs";
import { bboxProblem } from "./ingest/wfs";
import type { OnProgress, WfsRefresher } from "./wfs-service";
import type { BoxJobDeps } from "./wfs-worker";
import { refreshJob } from "./wfs-worker";
import type { Clock } from "./monitor";
import type { ChartIndex } from "./spatial/chart-index";
import { growBbox } from "./spatial/build-box";
import { MAX_CHART_BUFFER } from "./spatial/chart-position";
import { indexDirProblem } from "./spatial/chart-index";
import { EARTH_RADIUS } from "./foundation/geo";
import { WFS_SOURCE } from "./ingest/wfs";
import { cellSources } from "./index-loader";
import { Held, realWait, untilAborted } from "./planning-held";
import type { Survey } from "./survey";
import type { SurveyJob } from "./survey-worker";
import { wfsUrl } from "./charts-provider-wfs";

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
  /**
   * A corridor's boxes, when one was asked for: the index judges queries on the charts in
   * them alone, and in `region` (their box) past them reads no coverage.
   */
  readonly parts: readonly Bbox[] | undefined;
  readonly index: ChartIndex;
  /** False once released: its index is no longer the one held. */
  readonly live: boolean;
  /**
   * Counts a job reading the index from its turn in the request queue to its end; false once
   * released. A new build waits for every counted job to end before it replaces the files.
   */
  begin(): boolean;
  end(): void;
}

export type PrepareOutcome =
  { ok: true; held: HeldBox } | { ok: false; status: number; error: string };

export type SurveyOutcome =
  { ok: true; survey: Survey } | { ok: false; status: number; error: string };

/** Makes a depth survey (`survey-worker.ts`), in a build process of its own. */
export type SurveyRunner = (job: Omit<SurveyJob, "heapMb">, signal: AbortSignal) => Promise<Survey>;

/** A survey covers at most this much, km²: 47 tiles of the WFS at 60° N, a 4 MB grid. */
export const SURVEY_MAX_KM2 = 25_000;

export interface PlanningBoxDeps {
  /** Holds the planning box's Traficom WFS cell, when that source is on. */
  dir: string;
  /** The planning index's own directory, apart from the chart box's. */
  indexDir: string;
  /** The chart box service's job settings (`startWfs`), for the job of a planning box. */
  job: () => Omit<BoxJobDeps, "indexDir" | "inBox">;
  refresh: WfsRefresher;
  /** Makes a depth survey; absent, none is made (501). */
  survey?: SurveyRunner;
  /** Where a survey's grid is staged before it is read. */
  surveyDir?: string;
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

interface Running {
  bbox: Bbox;
  done: Promise<unknown>;
  controller: AbortController;
  /** Set when the chart box took the build process: the build is started again after it. */
  preempted: boolean;
  /** Lets the cell cache fill again, once the build has paused it. */
  resume?: () => void;
}

export class PlanningBoxes {
  private held: Held | undefined;
  /** The survey made last, and what was asked for. */
  private surveyed: { region: Bbox; survey: Survey } | undefined;
  /** Released indexes whose counted jobs may still read them: every build waits for them. */
  private draining: Held[] = [];
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
   * A planning index whose queries are judged on the charts across `region`, or across each
   * of `parts` alone, a corridor whose box is `region`: the one held when it covers them, else
   * one built for them. Waits for a chart box build to finish first, and starts again after
   * one that took over. Resolves with an error status when the region is too large (413), the
   * index directory refuses a commit or the build fails (503), or `signal` aborts (503).
   */
  prepare(
    region: Bbox,
    signal: AbortSignal,
    progress?: OnProgress,
    parts?: readonly Bbox[]
  ): Promise<PrepareOutcome> {
    const bbox = planningBbox(region);
    return this.exclusive<PrepareOutcome>(
      signal,
      () => {
        const held = this.held;
        if (held && covers(held, region, parts)) {
          held.usedAt = this.deps.clock.now();
          return { ok: true, held };
        }
        // Checked again after each wait: a build that ran out of memory meanwhile lowers the cap.
        let tooLarge: string | undefined;
        try {
          tooLarge = this.tooLarge(bbox, parts);
        } catch (err) {
          // cellsDir unreadable: its cells, and so the area held to the cap, are unknown.
          return {
            ok: false,
            status: 503,
            error: `the chart cells could not be read: ${(err as Error).message}`
          };
        }
        return tooLarge === undefined ? undefined : { ok: false, status: 413, error: tooLarge };
      },
      () => this.build(region, bbox, signal, progress, parts)
    );
  }

  /**
   * A depth survey (`survey.ts`) over `region` of cells about `cellMetres` on a side: the one
   * made last when it covers the region at that size or finer, else one made for it, in the
   * build process as a planning build is, one at a time. 501 without the Traficom WFS, 413
   * over SURVEY_MAX_KM2, 503 when it fails or `signal` aborts.
   */
  survey(region: Bbox, cellMetres: number, signal: AbortSignal): Promise<SurveyOutcome> {
    const runner = this.deps.survey;
    const config = this.deps.job().config;
    if (!runner || !("url" in config)) {
      return Promise.resolve({
        ok: false,
        status: 501,
        error: "a depth survey needs the Traficom WFS depth source"
      });
    }
    const km2 = bboxKm2(region);
    if (km2 > SURVEY_MAX_KM2) {
      return Promise.resolve({
        ok: false,
        status: 413,
        error: `the survey would cover ${Math.round(km2)} km²; at most ${SURVEY_MAX_KM2} km²`
      });
    }
    return this.exclusive<SurveyOutcome>(
      signal,
      () => {
        const last = this.surveyed;
        // Its cells as made: a large region's grid is coarser than asked for.
        return last && holds(last.region, region) && last.survey.cellMetres <= cellMetres
          ? { ok: true, survey: last.survey }
          : undefined;
      },
      () =>
        this.launch<SurveyOutcome>(
          region,
          signal,
          async (stop) => {
            const url = wfsUrl(config.url, config.viaChartsProvider);
            const job = { url, region, cellMetres, lowPriority: true };
            const staging = this.deps.surveyDir ?? path.join(this.deps.dir, "survey");
            const survey = await runner({ ...job, staging }, stop);
            if (stop.aborted) {
              // Stopped as it ended (the chart box took over): kept by no one, made again.
              return "again";
            }
            this.surveyed = { region, survey };
            return { ok: true, survey };
          },
          (err) => ({ ok: false, status: 503, error: `depth survey failed: ${err.message}` })
        )
    );
  }

  /**
   * `check` (what is held, or a refusal) after each wait for the running planning build and
   * the chart box, else `start` once the build process is free; `start` again after one the
   * chart box took over. 503 once stopped or `signal` aborts.
   */
  private async exclusive<T extends { ok: boolean }>(
    signal: AbortSignal,
    check: () => T | undefined,
    start: () => Promise<T | "again">
  ): Promise<T | Refusal> {
    const wait = this.deps.wait ?? realWait;
    for (;;) {
      if (this.stopped) {
        return { ok: false, status: 503, error: "plugin stopped" };
      }
      if (signal.aborted) {
        return aborted();
      }
      const now = check();
      if (now !== undefined) {
        return now;
      }
      const running = this.running;
      try {
        if (running) {
          await untilAborted(running.done, signal);
        } else if (this.deps.boxBusy()) {
          await wait(WAIT_MS, signal);
        } else {
          const r = await start();
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
   * How a planning box of `bbox`, or of its corridor's `parts`, is measured against the cap:
   * its WFS depths are downloaded for the parts alone, and with WFS depths alone in use its area
   * is theirs; S-57 cells are built across the whole box, which is then the area.
   */
  private measure(
    bbox: Bbox,
    parts?: readonly Bbox[]
  ): { km2: number; wfs: boolean; corridor: boolean } {
    const deps = this.deps.job();
    const wfs = "url" in deps.config;
    // The cells the build reads: those of the index in use, and any S-57 cell in cellsDir now.
    const cells =
      deps.index()?.catalogue.cells.some((c) => c.source !== WFS_SOURCE) === true ||
      (parts !== undefined && cellSources(deps.cellsDir).length > 0);
    const corridor = parts !== undefined && wfs && !cells;
    const km2 = corridor ? parts.reduce((sum, p) => sum + bboxKm2(p), 0) : bboxKm2(bbox);
    return { km2, wfs, corridor };
  }

  /** Why a planning box of `bbox`, or of its corridor's `parts`, is not built here, or undefined. */
  private tooLarge(bbox: Bbox, parts?: readonly Bbox[]): string | undefined {
    const { km2, wfs, corridor } = this.measure(bbox, parts);
    if (km2 > this.maxKm2) {
      return `the planning box would be ${Math.round(km2)} km²${corridor ? " in its corridor" : " with its reach"}; at most ${Math.round(this.maxKm2)} km² on this machine`;
    }
    // A Traficom WFS download has its own span limits, which no retry passes; a corridor's is
    // of its boxes, S-57 cells in use or not.
    const problem = wfs ? (parts ?? [bbox]).map(bboxProblem).find((p) => p) : undefined;
    return problem === undefined
      ? undefined
      : `the planning box is too large for the Traficom WFS: ${problem}`;
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
    const h = this.held;
    if (!h) {
      return;
    }
    h.live = false;
    this.held = undefined;
    // Kept only while a job still reads it, so a released index is not held in memory.
    if (!h.isIdle()) {
      this.draining.push(h);
      void h.idle().then(() => {
        this.draining = this.draining.filter((x) => x !== h);
      });
    }
  }

  /** Released indexes a job still reads; a new build waits for them. */
  stillRead(): number {
    return this.draining.length;
  }

  /** Settles once no job reads a released index; the barrier stays for the next build. */
  private async drained(): Promise<void> {
    await Promise.all(this.draining.map((h) => h.idle()));
  }

  private releaseIdle(): void {
    const h = this.held;
    if (h && this.deps.clock.now() - h.usedAt >= IDLE_MS) {
      this.deps.debug?.("planning box released after it went unused");
      this.release();
    }
  }

  /**
   * Runs `work` as the planning build over `bbox`, stopped when `signal` aborts, the plugin
   * stops or the chart box takes the build process (then "again"). An error `work` throws is
   * `failed`'s outcome. Warming is let fill again once it ends, unless the chart box took over.
   */
  private launch<T extends { ok: boolean }>(
    bbox: Bbox,
    signal: AbortSignal,
    work: (stop: AbortSignal, run: Running) => Promise<T | "again">,
    failed: (err: Error) => T
  ): Promise<T | Refusal | "again"> {
    const controller = new AbortController();
    const stopIt = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", stopIt, { once: true });
    const run: Running = { bbox, controller, preempted: false, done: Promise.resolve("again") };
    const done = (async (): Promise<T | Refusal | "again"> => {
      try {
        const r = await work(controller.signal, run);
        if (controller.signal.aborted) {
          return run.preempted ? "again" : aborted();
        }
        return r;
      } catch (err) {
        if (run.preempted && !signal.aborted && !this.stopped) {
          return "again";
        }
        return controller.signal.aborted ? aborted() : failed(err as Error);
      } finally {
        signal.removeEventListener("abort", stopIt);
        if (this.running === run) {
          this.running = undefined;
        }
        if (!run.preempted && !this.stopped) {
          run.resume?.();
        }
      }
    })();
    run.done = done;
    this.running = run;
    return done;
  }

  private build(
    region: Bbox,
    bbox: Bbox,
    signal: AbortSignal,
    progress: OnProgress | undefined,
    parts: readonly Bbox[] | undefined
  ): Promise<PrepareOutcome | "again"> {
    const problem = indexDirProblem(this.deps.indexDir);
    if (problem !== undefined) {
      return Promise.resolve({ ok: false, status: 503, error: `planning box: ${problem}` });
    }
    // The index it replaces takes no new job: its files are about to be replaced.
    this.release();
    const started = this.deps.clock.now();
    return this.launch<PrepareOutcome>(
      bbox,
      signal,
      async (stop, run) => {
        // A job still reading a released index ends before its files are replaced. The wait
        // gives way to the chart box, an abort or a stop; the next build waits for it again.
        await untilAborted(this.drained(), stop);
        fs.mkdirSync(this.deps.dir, { recursive: true });
        run.resume = await this.deps.pauseWarming?.();
        const deps = { ...this.deps.job(), indexDir: this.deps.indexDir, inBox: true };
        const job = refreshJob(deps, this.deps.dir, bbox, started, parts);
        const { index } = await this.deps.refresh({ ...job, lowPriority: true }, stop, progress);
        if (stop.aborted) {
          return "again";
        }
        // Without a WFS download the box is built whole, whatever corridor was asked for.
        const own = job.download === undefined ? undefined : parts;
        const held = new Held(region, bbox, own, index, this.deps.clock.now());
        this.held = held;
        this.deps.debug?.(
          `planning box built in ${Math.round((this.deps.clock.now() - started) / 1000)} s`
        );
        return { ok: true, held };
      },
      (err) => {
        if (OUT_OF_MEMORY.test(err.message)) {
          // Not tried at that size again in this run.
          let km2: number;
          try {
            km2 = this.measure(bbox, parts).km2;
          } catch {
            // cellsDir unreadable now: the smaller measure, the corridor's alone, is halved.
            km2 = parts ? parts.reduce((sum, p) => sum + bboxKm2(p), 0) : bboxKm2(bbox);
          }
          this.maxKm2 = Math.min(this.maxKm2, km2 * 0.5);
        }
        return { ok: false, status: 503, error: `planning box build failed: ${err.message}` };
      }
    );
  }
}

/** Whether `held` judges on the charts every query in `region`, or in each of its `parts`. */
function covers(held: HeldBox, region: Bbox, parts?: readonly Bbox[]): boolean {
  const have = held.parts ?? [held.region];
  return (parts ?? [region]).every((p) => have.some((q) => holds(q, p)));
}

type Refusal = { ok: false; status: number; error: string };

function aborted(): Refusal {
  return { ok: false, status: 503, error: "planning box request aborted" };
}

const cellKey = (c: { name: string; edition: number; update: number }): string =>
  `${c.name}/${c.edition}/${c.update}`;

/** The revision of the living chart's adjustments each planning store last took, and from what. */
const carried = new WeakMap<object, { from: object; revision: number }>();

/**
 * Puts the living chart's adjustments of `from` (the index in use) on `to` (a planning box),
 * each with the catalogue reference of the same cell in `to`. Taking them only lowers a depth
 * (invariant 5), so a planning box reads no deeper than the index in use where the boat has
 * sounded. False when the two index the adjustments at different zooms and cannot share them.
 */
export function carryAdjustments(from: ChartIndex, to: ChartIndex): boolean {
  const src = from.pyramid.adjustments;
  const dst = to.pyramid.adjustments;
  const last = carried.get(to.pyramid);
  if (last && last.from === from.pyramid && last.revision === src.revision) {
    return true;
  }
  if (src.size > 0 && from.pyramid.adjustZoom !== to.pyramid.adjustZoom) {
    return false;
  }
  const refs = new Map(to.catalogue.cells.map((c, i) => [cellKey(c), i]));
  const cells = from.catalogue.cells;
  dst.clear();
  for (const [key, v] of src) {
    const cell = cells[v.cellRef];
    dst.set(key, { ...v, cellRef: cell ? (refs.get(cellKey(cell)) ?? -1) : -1 });
  }
  carried.set(to.pyramid, { from: from.pyramid, revision: src.revision });
  return true;
}
