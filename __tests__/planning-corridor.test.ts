import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import type { Bbox, WfsFetch } from "../src/ingest/wfs";
import { DEFAULT_WFS_URL } from "../src/ingest/wfs";
import type { PlanningBoxDeps, SurveyRunner } from "../src/planning-box";
import { PlanningBoxes, SURVEY_MAX_KM2 } from "../src/planning-box";
import type { Prepared, Session } from "../src/planning-api";
import { planningApi } from "../src/planning-api";
import { corridorError, MAX_CORRIDOR_PARTS } from "../src/planning-survey";
import type { RouteServiceDeps } from "../src/route-service";
import { RequestQueue } from "../src/route-service";
import { runBuild } from "../src/spatial/build-worker";
import { commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import type { Survey } from "../src/survey";
import { surveyGrid } from "../src/survey";
import type { IndexBuilder, WfsRefresher } from "../src/wfs-service";
import { inThreadRefresher } from "../src/wfs-service";
import type { WfsJob } from "../src/wfs-worker";
import { fixtureIndex, prepareFixtureIndex } from "./helpers/fixture-index";
import { fakeClock } from "./helpers/plugin-harness";

/**
 * The corridor and the depth survey (signalk-route-planner's plan §4.2): a planning box of a
 * corridor's boxes alone, its memory going with their area, and a survey made in the build
 * process's turn.
 */

beforeAll(prepareFixtureIndex);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-corridor-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-19T07:00:00Z");
const NEVER = new AbortController().signal;
const FAR: Bbox = [10, 50, 10.2, 50.1];
const WFS = { url: DEFAULT_WFS_URL, radiusKm: 10, catzoc: 3 };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

function routeDeps(over: Partial<RouteServiceDeps>): RouteServiceDeps {
  return {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({}),
    vessel: () => ({ draft: 1.5, length: 10, beam: 3.5 }),
    waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    waveHeight: () => undefined,
    getRoute: () => Promise.reject(new Error("no routes")),
    now: () => NOW,
    queue: new RequestQueue(),
    ...over
  };
}

async function segment(p: Prepared, a: LonLat, b: LonLat) {
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

const inProcess: IndexBuilder = async (job) => {
  const r = await runBuild({ ...job, threads: 1 });
  commitChartIndex(job.indexDir, r.staging);
  return loadChartIndex(job.indexDir);
};

const square = ([w, s, e, n]: Bbox): number[][][] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s]
  ]
];

/** A WFS with one deep depth area over everything, paged; it counts the page requests. */
function deepWater(asked: string[]): WfsFetch {
  const layers: Record<string, unknown[]> = {
    "rajoitettu:DepthArea_A": [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: square([20, 59, 24, 61]) },
        properties: { DRVAL1: 20, DRVAL2: 50, IDENTIFIER: "FI DEEP" }
      }
    ]
  };
  return (url) => {
    const u = new URL(url);
    const features = layers[u.searchParams.get("typeNames") ?? ""] ?? [];
    if (u.searchParams.get("resultType") === "hits") {
      const xml = `<wfs:FeatureCollection numberMatched="${features.length}"/>`;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(xml) });
    }
    asked.push(u.searchParams.get("bbox") ?? "");
    const start = Number(u.searchParams.get("startIndex"));
    const body = { type: "FeatureCollection", features: features.slice(start, start + 5000) };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body))
    });
  };
}

function boxes(over: Partial<PlanningBoxDeps>): PlanningBoxes {
  return new PlanningBoxes({
    dir: path.join(dir, "planning-box"),
    indexDir: path.join(dir, "planning-index"),
    job: () => ({ config: WFS, index: () => undefined, leafZoom: 16 }),
    refresh: () => Promise.reject(new Error("no refresh")),
    maxKm2: 400,
    boxBusy: () => false,
    clock: fakeClock(NOW),
    wait: () => new Promise((r) => setImmediate(r)),
    ...over
  });
}

/** Two rows of a corridor running east, 0.3° long: its box is 4 times its area. */
const ROW_A: Bbox = [22.0, 60.0, 22.15, 60.01];
const ROW_B: Bbox = [22.15, 60.01, 22.3, 60.02];
const CORRIDOR = [ROW_A, ROW_B];
const REGION: Bbox = [22.0, 60.0, 22.3, 60.02];

describe("corridor", () => {
  test("the planning box covers the corridor's boxes: charted in them, no coverage past them", async () => {
    const asked: string[] = [];
    const b = boxes({ refresh: inThreadRefresher(deepWater(asked), inProcess) });
    const api = planningApi(
      () => routeDeps({ chartBox: () => FAR }),
      "test",
      () => b
    );
    expect(api.features).toEqual(expect.arrayContaining(["corridor", "survey"]));
    const r = await api.prepare(REGION, NEVER, CORRIDOR);
    if (!r.ok) {
      throw new Error(r.error);
    }
    const inside = await segment(r.value, [22.05, 60.005], [22.06, 60.005]);
    expect(inside.flags).not.toContain("NO_COVERAGE");
    // Traficom depths are advisory: charted, never clear.
    expect(inside.flags).toEqual(["NOT_FOR_NAVIGATION"]);
    // In the region's box but past the corridor: no chart, unverified.
    const past = await segment(r.value, [22.05, 60.017], [22.06, 60.017]);
    expect(past.status).toBe("unverified");
    expect(past.flags).toContain("NO_COVERAGE");
    // A region inside one of the boxes reuses it; one past them builds again.
    const again = await api.prepare([22.02, 60.002, 22.04, 60.008], NEVER);
    expect(again.ok).toBe(true);
    const pages = asked.length;
    await api.prepare([22.02, 60.012, 22.04, 60.018], NEVER);
    expect(asked.length).toBeGreaterThan(pages);
  });

  test("the corridor's area, not its box's, is held to the cap, with WFS depths alone", async () => {
    const jobs: WfsJob[] = [];
    const refresh: WfsRefresher = (job) => {
      jobs.push(job);
      return Promise.resolve({
        index: fixtureIndex(),
        features: { depthAreas: 0, dredgedAreas: 0, soundings: 0 }
      });
    };
    // The box with its reach is about 25 km² by 10 km; the corridor's boxes 14 km².
    const b = boxes({ refresh, maxKm2: 20 });
    expect(await b.prepare(REGION, NEVER)).toMatchObject({ ok: false, status: 413 });
    const r = await b.prepare(REGION, NEVER, undefined, CORRIDOR);
    expect(r.ok).toBe(true);
    expect(jobs[0]?.download?.parts).toEqual(CORRIDOR);
    // With S-57 cells in use the build spans the whole box: its area is held to the cap.
    const encs = boxes({
      refresh,
      maxKm2: 20,
      job: () => ({ config: WFS, index: () => fixtureIndex(), leafZoom: 16 })
    });
    expect(await encs.prepare(REGION, NEVER, undefined, CORRIDOR)).toMatchObject({
      ok: false,
      status: 413
    });
  });

  test("a corridor not within its region, or of too many boxes, is 400", async () => {
    expect(corridorError(REGION, CORRIDOR)).toBeUndefined();
    expect(corridorError(REGION, [[22.0, 60.0, 22.4, 60.01]])).toMatch(/lie in the region/);
    expect(corridorError(REGION, [])).toMatch(/1 to/);
    expect(corridorError(REGION, Array(MAX_CORRIDOR_PARTS + 1).fill(ROW_A))).toMatch(/1 to/);
    expect(corridorError(REGION, [[22.1, 60.0, 22.0, 60.01]])).toMatch(/west < east/);
    const api = planningApi(
      () => routeDeps({ chartBox: () => FAR }),
      "test",
      () => boxes({})
    );
    expect(await api.prepare(REGION, NEVER, [[22, 60, 23, 61]])).toMatchObject({
      ok: false,
      status: 400
    });
  });
});

describe("survey", () => {
  const grid = (region: Bbox): Survey => surveyGrid(region, 200);

  test("made once in the build process's turn and reused for a region inside it", async () => {
    const jobs: Parameters<SurveyRunner>[0][] = [];
    let finish: () => void = () => undefined;
    const survey: SurveyRunner = (job) =>
      new Promise((resolve) => {
        jobs.push(job);
        finish = () => resolve(grid(job.region));
      });
    const b = boxes({ survey, surveyDir: path.join(dir, "planning-survey") });
    const api = planningApi(
      () => routeDeps({ chartBox: () => FAR }),
      "test",
      () => b
    );
    const first = api.survey?.([22, 60, 22.5, 60.2], 200, NEVER);
    await flush();
    expect(b.building()).toBe(true);
    expect(jobs[0]).toMatchObject({ url: DEFAULT_WFS_URL, cellMetres: 200, lowPriority: true });
    expect(jobs[0]?.staging).toBe(path.join(dir, "planning-survey"));
    finish();
    const r = await first;
    expect(r?.ok).toBe(true);
    const inner = await api.survey?.([22.1, 60.05, 22.3, 60.1], 500, NEVER);
    expect(inner?.ok && r?.ok && inner.value === r.value).toBe(true);
    expect(jobs).toHaveLength(1);
    // Finer than the one made: made again.
    void api.survey?.([22.1, 60.05, 22.3, 60.1], 100, NEVER);
    await flush();
    expect(jobs).toHaveLength(2);
  });

  test("waits for the chart box, gives way to it, and is made again after", async () => {
    let busy = true;
    const jobs: Bbox[] = [];
    let finish: () => void = () => undefined;
    const survey: SurveyRunner = (job, signal) =>
      new Promise((resolve, reject) => {
        jobs.push(job.region);
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        finish = () => resolve(grid(job.region));
      });
    const b = boxes({ survey, boxBusy: () => busy });
    const r = b.survey([22, 60, 22.5, 60.2], 200, NEVER);
    await flush();
    expect(jobs).toHaveLength(0);
    busy = false;
    await flush();
    expect(jobs).toHaveLength(1);
    await b.preempt();
    await flush();
    expect(jobs).toHaveLength(2);
    finish();
    expect((await r).ok).toBe(true);
  });

  test("refused without the Traficom WFS (501), over its area (413), for a bad cell (400)", async () => {
    const survey: SurveyRunner = (job) => Promise.resolve(grid(job.region));
    const enc = boxes({
      survey,
      job: () => ({ config: { radiusKm: 10 }, index: () => undefined, leafZoom: 16 })
    });
    expect(await enc.survey([22, 60, 22.5, 60.2], 200, NEVER)).toMatchObject({ status: 501 });
    expect(await boxes({}).survey([22, 60, 22.5, 60.2], 200, NEVER)).toMatchObject({
      status: 501
    });
    const b = boxes({ survey });
    const km2 = (SURVEY_MAX_KM2 / 12364) * 1.2;
    expect(await b.survey([20, 0, 20 + km2, 1], 200, NEVER)).toMatchObject({ status: 413 });
    const api = planningApi(
      () => routeDeps({}),
      "test",
      () => b
    );
    expect(await api.survey?.([22, 60, 22.5, 60.2], 10, NEVER)).toMatchObject({ status: 400 });
    expect(await api.survey?.([22, 61, 22.5, 60.2], 200, NEVER)).toMatchObject({ status: 400 });
  });
});
