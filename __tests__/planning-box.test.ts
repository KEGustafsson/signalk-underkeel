import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import type { Bbox } from "../src/ingest/wfs";
import type { PlanningBoxDeps } from "../src/planning-box";
import {
  bboxKm2,
  holds,
  IDLE_MS,
  planningBbox,
  PlanningBoxes,
  regionError,
  carryAdjustments
} from "../src/planning-box";
import type { PlanningApiV1, Prepared, Session } from "../src/planning-api";
import { planningApi } from "../src/planning-api";
import type { RouteServiceDeps } from "../src/route-service";
import { RequestQueue } from "../src/route-service";
import { runBuild } from "../src/spatial/build-worker";
import type { ChartIndex } from "../src/spatial/chart-index";
import { buildChartIndex, commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import { ADJUST_ZOOM } from "../src/spatial/node-store";
import { tileKey } from "../src/foundation/geo";
import { readCellDirectory } from "../src/ingest/cell-reader";
import type { IndexBuilder, WfsRefresher } from "../src/wfs-service";
import { inThreadRefresher } from "../src/wfs-service";
import { overlaps, yieldingWarmer } from "../src/wfs-wiring";
import type { WfsJob } from "../src/wfs-worker";
import { CELLS, FIXTURES, fixtureIndex, prepareFixtureIndex, ROCK } from "./helpers/fixture-index";
import { fakeClock } from "./helpers/plugin-harness";

/**
 * Planning boxes (signalk-route-planner's plan §4.2): an index built on request for a region the
 * chart box does not reach, one at a time, behind the chart box, released once unused.
 */

beforeAll(prepareFixtureIndex);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-planning-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-18T07:00:00Z");
const NEVER = new AbortController().signal;
const REGION: Bbox = [22.0, 60.0, 22.04, 60.02];

describe("regions", () => {
  test("a region is [west, south, east, north] with west < east and south < north", () => {
    expect(regionError(REGION)).toBeUndefined();
    expect(regionError([22, 60, 21, 61])).toBeDefined();
    expect(regionError([22, 61, 23, 60])).toBeDefined();
    expect(regionError([22, 60, 23])).toBeDefined();
    expect(regionError([22, 60, 23, NaN])).toBeDefined();
    expect(regionError([22, 86, 23, 87])).toBeDefined();
    expect(regionError("22,60,23,61")).toBeDefined();
  });

  test("the box is the region grown by the widest chart position reach", () => {
    const b = planningBbox(REGION);
    expect(holds(b, REGION)).toBe(true);
    // 1.86 km on each side, north and south.
    expect((REGION[1] - b[1]) * 111.2).toBeCloseTo(1.86, 1);
    expect(bboxKm2([0, 0, 1, 1])).toBeCloseTo(12364, -1);
  });
});

interface Fake {
  jobs: WfsJob[];
  release: () => void;
  fail?: string;
}

/** A refresh that resolves with `index` once `release` is called, or fails with `fail`. */
function fakeRefresh(index: ChartIndex, fake: Fake): WfsRefresher {
  return (job, signal) =>
    new Promise((resolve, reject) => {
      fake.jobs.push(job);
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      fake.release = () =>
        fake.fail ? reject(new Error(fake.fail)) : resolve({ index, features: fakeCounts });
    });
}

const fakeCounts = { depthAreas: 0, dredgedAreas: 0, soundings: 0 };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

function boxes(over: Partial<PlanningBoxDeps> & { fake: Fake }) {
  const clock = fakeClock(NOW);
  const b = new PlanningBoxes({
    dir: path.join(dir, "planning-box"),
    indexDir: path.join(dir, "planning-index"),
    job: () => ({ config: { radiusKm: 10 }, index: () => undefined, leafZoom: 16 }),
    refresh: fakeRefresh(fixtureIndex(), over.fake),
    maxKm2: 400,
    boxBusy: () => false,
    clock,
    wait: () => new Promise((r) => setImmediate(r)),
    ...over
  });
  return { b, clock };
}

describe("PlanningBoxes", () => {
  test("builds a region once, at low priority in its own index, and reuses it for a region inside", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({ fake });
    const first = b.prepare(REGION, NEVER);
    await flush();
    expect(b.building()).toBe(true);
    fake.release();
    const r = await first;
    expect(r.ok).toBe(true);
    const job = fake.jobs[0] as WfsJob;
    expect(job.lowPriority).toBe(true);
    expect(job.box).toEqual(planningBbox(REGION));
    expect(job.build.indexDir).toBe(path.join(dir, "planning-index"));
    const inner = await b.prepare([22.01, 60.005, 22.03, 60.015], NEVER);
    expect(inner.ok && r.ok && inner.held === r.held).toBe(true);
    expect(fake.jobs).toHaveLength(1);
  });

  test("refuses a region too large to build on the machine, with 413", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({ fake, maxKm2: 50 });
    const r = await b.prepare([22, 60, 23, 61], NEVER);
    expect(r).toMatchObject({ ok: false, status: 413 });
    expect(fake.jobs).toHaveLength(0);
  });

  test("waits while the chart box builds, then builds", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    let busy = true;
    const { b } = boxes({ fake, boxBusy: () => busy });
    const r = b.prepare(REGION, NEVER);
    await flush();
    expect(fake.jobs).toHaveLength(0);
    busy = false;
    await flush();
    expect(fake.jobs).toHaveLength(1);
    fake.release();
    expect((await r).ok).toBe(true);
  });

  test("gives way to the chart box, then builds again", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    let busy = false;
    const { b } = boxes({ fake, boxBusy: () => busy });
    const r = b.prepare(REGION, NEVER);
    await flush();
    busy = true;
    await b.preempt();
    expect(b.building()).toBe(false);
    await flush();
    expect(fake.jobs).toHaveLength(1);
    busy = false;
    await flush();
    expect(fake.jobs).toHaveLength(2);
    fake.release();
    expect((await r).ok).toBe(true);
  });

  test("an aborted request ends its build and answers 503", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({ fake });
    const c = new AbortController();
    const r = b.prepare(REGION, c.signal);
    await flush();
    c.abort();
    expect(await r).toMatchObject({ ok: false, status: 503 });
    expect(b.building()).toBe(false);
  });

  test("a failed build answers 503; one out of memory lowers the area tried", async () => {
    const fake: Fake = {
      jobs: [],
      release: () => undefined,
      fail: "index build stopped at the 256 MB heap limit"
    };
    const { b } = boxes({ fake });
    const r = b.prepare(REGION, NEVER);
    await flush();
    fake.release();
    expect(await r).toMatchObject({ ok: false, status: 503 });
    // Half the box's area: the same region is now too large.
    expect(await b.prepare(REGION, NEVER)).toMatchObject({ ok: false, status: 413 });
  });

  test("releases an index unused for IDLE_MS, and builds again when asked", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b, clock } = boxes({ fake });
    const r = b.prepare(REGION, NEVER);
    await flush();
    fake.release();
    const got = await r;
    expect(got.ok).toBe(true);
    clock.advance(IDLE_MS / 2);
    expect(b.current()).toBeDefined();
    clock.advance(IDLE_MS / 2);
    expect(b.current()).toBeUndefined();
    expect(got.ok && got.held.live).toBe(false);
    const again = b.prepare(REGION, NEVER);
    await flush();
    fake.release();
    expect((await again).ok).toBe(true);
    expect(fake.jobs).toHaveLength(2);
  });

  test("stopped, it releases its index and builds nothing more", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({ fake });
    b.stop();
    expect(await b.prepare(REGION, NEVER)).toMatchObject({ ok: false, status: 503 });
    expect(fake.jobs).toHaveLength(0);
  });
});

/** The build job run in-process: stage, commit and load, as workerBuilder does. */
const inProcess: IndexBuilder = async (job) => {
  const r = await runBuild({ ...job, threads: 1 });
  commitChartIndex(job.indexDir, r.staging);
  return loadChartIndex(job.indexDir);
};

function routeDeps(over: Partial<RouteServiceDeps>): RouteServiceDeps {
  return {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({}),
    vessel: () => ({ draft: 3.6, length: 12, beam: 4 }),
    waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    waveHeight: () => undefined,
    getRoute: () => Promise.reject(new Error("no routes")),
    now: () => NOW,
    queue: new RequestQueue(),
    ...over
  };
}

async function segment(p: Prepared | PlanningApiV1, a: LonLat, b: LonLat) {
  const r = await p.session(
    { departure: NOW, until: NOW + 3_600_000, speed: 3 },
    NEVER,
    async (s: Session) => s.segment(a, b)
  );
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.value;
}

const FAR: Bbox = [10, 50, 10.2, 50.1];

describe("prepare", () => {
  test("serves the features it adds", () => {
    expect(planningApi(() => routeDeps({}), "test").features).toContain("prepare");
  });

  test("a whole index covers any region: no build", async () => {
    const api = planningApi(() => routeDeps({}), "test");
    const r = await api.prepare(REGION, NEVER);
    expect(r.ok && r.value.coverage).toBeUndefined();
  });

  test("the chart box covers a region well inside it, until it moves off it", async () => {
    let box: Bbox = [21.9, 59.9, 22.2, 60.1];
    const api = planningApi(() => routeDeps({ chartBox: () => box }), "test");
    const r = await api.prepare(REGION, NEVER);
    if (!r.ok) {
      throw new Error(r.error);
    }
    expect(r.value.coverage).toEqual(box);
    expect((await segment(r.value, [22.0, 60.005], [22.03, 60.005])).status).toBeDefined();
    box = FAR;
    const moved = await r.value.session(
      { departure: NOW, until: NOW + 1000, speed: 3 },
      NEVER,
      async () => 1
    );
    expect(moved).toMatchObject({ ok: false, status: 503 });
  });

  test("a region past the chart box with no planning boxes is 503; a bad one 400", async () => {
    const api = planningApi(() => routeDeps({ chartBox: () => FAR }), "test");
    expect(await api.prepare(REGION, NEVER)).toMatchObject({ ok: false, status: 503 });
    expect(await api.prepare([1, 2, 0, 3] as Bbox, NEVER)).toMatchObject({
      ok: false,
      status: 400
    });
  });

  test("builds a planning box from the cells: charted inside, no coverage outside", async () => {
    const clock = fakeClock(NOW);
    const b = new PlanningBoxes({
      dir: path.join(dir, "planning-box"),
      indexDir: path.join(dir, "planning-index"),
      job: () => ({
        config: { radiusKm: 10 },
        cellsDir: CELLS,
        index: () => undefined,
        leafZoom: 16
      }),
      refresh: inThreadRefresher(() => Promise.reject(new Error("no WFS")), inProcess),
      maxKm2: 400,
      boxBusy: () => false,
      clock
    });
    const deps = routeDeps({ chartBox: () => FAR });
    const api = planningApi(
      () => deps,
      "test",
      () => b
    );
    const region: Bbox = [ROCK[0] - 0.02, ROCK[1] - 0.01, ROCK[0] + 0.02, ROCK[1] + 0.01];
    const r = await api.prepare(region, NEVER);
    if (!r.ok) {
      throw new Error(r.error);
    }
    expect(r.value.coverage).toEqual(planningBbox(region));
    // Over the rock the planning box fails the leg as the whole index does.
    const over = await segment(r.value, [ROCK[0] - 0.003, ROCK[1]], [ROCK[0] + 0.003, ROCK[1]]);
    const whole = await segment(
      planningApi(() => routeDeps({}), "test"),
      [ROCK[0] - 0.003, ROCK[1]],
      [ROCK[0] + 0.003, ROCK[1]]
    );
    expect(over.status).toBe(whole.status);
    expect(over.status).toBe("fail");
    // Far past the box there is no chart: unverified, never ok.
    const past = await segment(r.value, [ROCK[0] + 0.2, ROCK[1]], [ROCK[0] + 0.203, ROCK[1]]);
    expect(past.status).toBe("unverified");
    expect(past.flags).toContain("NO_COVERAGE");
    // Released, its sessions answer 503.
    r.value.release();
    const gone = await r.value.session(
      { departure: NOW, until: NOW + 1000, speed: 3 },
      NEVER,
      async () => 1
    );
    expect(gone).toMatchObject({ ok: false, status: 503 });
    b.stop();
  });
});

describe("carryAdjustments", () => {
  test("puts the living chart's adjustments on the planning index, with its own cell references", () => {
    const from = fixtureIndex();
    const to = reversedIndex();
    const z = Math.min(ADJUST_ZOOM, from.pyramid.leafZoom);
    const key = tileKey(z, 1, 2);
    from.pyramid.adjustments.set(key, { dMin: 1, sigmaD: 0.1, sigmaP: 1, flags: 0, cellRef: 0 });
    expect(carryAdjustments(from, to)).toBe(true);
    const name = from.catalogue.cells[0]?.name;
    const ref = to.catalogue.cells.findIndex((c) => c.name === name);
    expect(ref).toBe(1);
    expect(to.pyramid.adjustments.get(key)).toMatchObject({ dMin: 1, cellRef: ref });
    // Again at the same revision, nothing changes; a removal is carried.
    const rev = to.pyramid.adjustments.revision;
    expect(carryAdjustments(from, to)).toBe(true);
    expect(to.pyramid.adjustments.revision).toBe(rev);
    from.pyramid.adjustments.delete(key);
    carryAdjustments(from, to);
    expect(to.pyramid.adjustments.size).toBe(0);
  });
});

/** The same cells in the other order: each cell has another catalogue reference there. */
function reversedIndex(): ChartIndex {
  return buildChartIndex(
    [
      readCellDirectory(path.join(FIXTURES, "FI4SYNTH"), 0),
      readCellDirectory(path.join(FIXTURES, "FI5SYNTH"), 1)
    ],
    { minZoom: 12, leafZoom: 18 }
  );
}

describe("yieldingWarmer", () => {
  test("stops a planning build ahead of each chart box build, and resumes the filling after one", async () => {
    const calls: string[] = [];
    const inner = {
      boxInUse: (b: Bbox, km: number) => calls.push(`in use ${b.join(",")} ${km}`),
      beforeBuild: () => {
        calls.push("pause");
        return Promise.resolve();
      },
      stop: () => calls.push("stop")
    };
    const planning = {
      preempt: () => {
        calls.push("preempt");
        return Promise.resolve();
      }
    } as unknown as PlanningBoxes;
    const w = yieldingWarmer({ state: { planning } as never }, inner);
    await w.beforeBuild();
    expect(calls).toEqual(["preempt", "pause"]);
    const resume = await w.pause();
    // Nothing in use yet: nothing to resume.
    resume();
    w.boxInUse(REGION, 9);
    calls.length = 0;
    (await w.pause())();
    expect(calls).toEqual(["pause", `in use ${REGION.join(",")} 9`]);
  });
});

describe("review fixes", () => {
  test("an already aborted request is refused even where the index in use covers the region", async () => {
    const c = new AbortController();
    c.abort();
    const api = planningApi(() => routeDeps({}), "test");
    expect(await api.prepare(REGION, c.signal)).toMatchObject({ ok: false, status: 503 });
  });

  test("an index saved with a box is not whole before the box service reports one", async () => {
    const api = planningApi(() => routeDeps({ indexBox: () => FAR }), "test");
    // Past the saved box, and no planning boxes: refused, not served by the clipped index.
    expect(await api.prepare(REGION, NEVER)).toMatchObject({ ok: false, status: 503 });
    const inside = planningApi(
      () => routeDeps({ indexBox: () => [21.9, 59.9, 22.2, 60.1] }),
      "test"
    );
    const r = await inside.prepare(REGION, NEVER);
    expect(r.ok && r.value.coverage).toEqual([21.9, 59.9, 22.2, 60.1]);
  });

  test("a WFS planning box past the WFS span limits is 413, before any build", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({
      fake,
      maxKm2: 1e6,
      job: () => ({
        config: { url: "https://example.invalid/wfs", radiusKm: 10, catzoc: "B" } as never,
        index: () => undefined,
        leafZoom: 16
      })
    });
    const r = await b.prepare([22, 60, 22.01, 60.6], NEVER);
    expect(r).toMatchObject({ ok: false, status: 413, error: expect.stringMatching(/WFS/) });
    expect(fake.jobs).toHaveLength(0);
  });

  test("a request waiting for a build that ran out of memory is 413 when the cap falls below it", async () => {
    const fake: Fake = {
      jobs: [],
      release: () => undefined,
      fail: "index build stopped at the 256 MB heap limit"
    };
    const { b } = boxes({ fake });
    const first = b.prepare(REGION, NEVER);
    await flush();
    const second = b.prepare(REGION, NEVER);
    await flush();
    fake.release();
    expect(await first).toMatchObject({ status: 503 });
    expect(await second).toMatchObject({ ok: false, status: 413 });
    expect(fake.jobs).toHaveLength(1);
  });

  test("a planning directory that cannot be made fails only the build, with 503", async () => {
    const file = path.join(dir, "planning-box");
    fs.writeFileSync(file, "not a directory");
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({ fake, dir: file });
    expect(await b.prepare(REGION, NEVER)).toMatchObject({ ok: false, status: 503 });
    expect(fake.jobs).toHaveLength(0);
  });

  test("a new build waits for a job still reading the index it replaces", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({ fake });
    const first = b.prepare(REGION, NEVER);
    await flush();
    fake.release();
    const got = await first;
    if (!got.ok) {
      throw new Error(got.error);
    }
    expect(got.held.begin()).toBe(true);
    const other = b.prepare(FAR, NEVER);
    await flush();
    // Released: no new job reads it, but the one reading it holds the build back.
    expect(got.held.begin()).toBe(false);
    expect(fake.jobs).toHaveLength(1);
    got.held.end();
    await flush();
    expect(fake.jobs).toHaveLength(2);
    fake.release();
    expect((await other).ok).toBe(true);
  });

  test("the chart box need not wait for a reader of a released index; the next build still does", async () => {
    const fake: Fake = { jobs: [], release: () => undefined };
    let busy = false;
    const { b } = boxes({ fake, boxBusy: () => busy });
    const first = b.prepare(REGION, NEVER);
    await flush();
    fake.release();
    const got = await first;
    if (!got.ok) {
      throw new Error(got.error);
    }
    expect(got.held.begin()).toBe(true);
    const other = b.prepare(FAR, NEVER);
    await flush();
    // The chart box takes over while the build waits for the reader: it is not held up.
    busy = true;
    let yielded = false;
    void b.preempt().then(() => (yielded = true));
    await flush();
    expect(yielded).toBe(true);
    busy = false;
    await flush();
    // Started again, it still waits for the reader before replacing the files.
    expect(fake.jobs).toHaveLength(1);
    got.held.end();
    await flush();
    expect(fake.jobs).toHaveLength(2);
    fake.release();
    expect((await other).ok).toBe(true);
  });

  test("a queued planning session takes the living chart as it is at its turn, and the box's own datums", async () => {
    const queue = new RequestQueue();
    const main = fixtureIndex();
    const planned = reversedIndex();
    const fake: Fake = { jobs: [], release: () => undefined };
    const { b } = boxes({ fake, refresh: fakeRefresh(planned, fake) });
    const levelsFor: unknown[] = [];
    const deps = routeDeps({
      index: main,
      queue,
      chartBox: () => FAR,
      waterLevelFor: (cells) => {
        levelsFor.push(cells);
        return () => ({ h: 0, sigma: 0.3, source: "chart-datum" });
      }
    });
    const api = planningApi(
      () => deps,
      "test",
      () => b
    );
    const p = api.prepare(REGION, NEVER);
    await flush();
    fake.release();
    const r = await p;
    if (!r.ok) {
      throw new Error(r.error);
    }
    // Another request holds the queue while the planner's session waits for its turn.
    let free: () => void = () => undefined;
    const busy = queue.run(
      NEVER,
      () => new Promise((resolve) => (free = () => resolve({ status: 200, body: null })))
    );
    const key = tileKey(Math.min(ADJUST_ZOOM, main.pyramid.leafZoom), 3, 4);
    const seen = r.value.session(
      { departure: NOW, until: NOW + 1000, speed: 3 },
      NEVER,
      async (s: Session) => {
        s.segment([22.0, 60.005], [22.01, 60.005]);
        return planned.pyramid.adjustments.has(key);
      }
    );
    await flush();
    // A sounding confirmed while it waits.
    main.pyramid.adjustments.set(key, { dMin: 1, sigmaD: 0.1, sigmaP: 1, flags: 0, cellRef: 0 });
    free();
    await busy;
    expect(await seen).toEqual({ ok: true, value: true });
    expect(levelsFor).toContain(planned.catalogue.cells);
    main.pyramid.adjustments.delete(key);
    // Released while queued: refused at its turn.
    const busy2 = queue.run(
      NEVER,
      () => new Promise((resolve) => (free = () => resolve({ status: 200, body: null })))
    );
    const late = r.value.session(
      { departure: NOW, until: NOW + 1000, speed: 3 },
      NEVER,
      async () => 1
    );
    await flush();
    r.value.release();
    free();
    await busy2;
    expect(await late).toMatchObject({ ok: false, status: 503 });
    b.stop();
  });

  test("overlaps: one directory, one inside the other, or through a link", () => {
    const a = path.join(dir, "data");
    fs.mkdirSync(a);
    fs.symlinkSync(a, path.join(dir, "link"));
    expect(overlaps(a, a)).toBe(true);
    expect(overlaps(path.join(a, "planning-index"), a)).toBe(true);
    expect(overlaps(a, path.join(a, "planning-index"))).toBe(true);
    expect(overlaps(path.join(dir, "link", "planning-index"), path.join(a, "planning-index"))).toBe(
      true
    );
    expect(overlaps(path.join(a, "planning-index"), path.join(a, "index"))).toBe(false);
    expect(overlaps(path.join(a, "index2"), path.join(a, "index"))).toBe(false);
  });
});
