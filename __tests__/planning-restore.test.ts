import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import type { LonLat } from "../src/foundation/geo";
import type { Bbox } from "../src/ingest/wfs";
import type { PlanningApiV1, Prepared, Session } from "../src/planning-api";
import { planningApi } from "../src/planning-api";
import type { PlanningBoxDeps } from "../src/planning-box";
import { NOT_HELD, planningBbox, PlanningBoxes } from "../src/planning-box";
import {
  holdFile,
  holdStamp,
  readHold,
  restorable,
  RESTORE_MAX_AGE_MS,
  writeHold
} from "../src/planning-restore";
import type { RouteServiceDeps } from "../src/route-service";
import { RequestQueue } from "../src/route-service";
import { runBuild } from "../src/spatial/build-worker";
import { commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import { regionGroups } from "../src/spatial/region-jobs";
import type { IndexBuilder, WfsRefresher } from "../src/wfs-service";
import { inThreadRefresher } from "../src/wfs-service";
import { CELLS, fixtureIndex, prepareFixtureIndex, ROCK } from "./helpers/fixture-index";
import { fakeClock } from "./helpers/plugin-harness";

/**
 * A planning index read back (`planning-restore.ts`): the index a build saved serves a region
 * again after it was released or the plugin restarted, while it is what a build now would make.
 */

beforeAll(prepareFixtureIndex);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-restore-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-18T07:00:00Z");
const NEVER = new AbortController().signal;
const REGION: Bbox = [ROCK[0] - 0.02, ROCK[1] - 0.01, ROCK[0] + 0.02, ROCK[1] + 0.01];
const INSIDE: Bbox = [ROCK[0] - 0.01, ROCK[1] - 0.005, ROCK[0] + 0.01, ROCK[1] + 0.005];
const FAR: Bbox = [10, 50, 10.2, 50.1];

const inProcess: IndexBuilder = async (job) => {
  const r = await runBuild({ ...job, threads: 1 });
  commitChartIndex(job.indexDir, r.staging);
  return loadChartIndex(job.indexDir);
};

/** A build that counts itself, on this thread. */
function counting(): { refresh: WfsRefresher; builds: () => number } {
  let n = 0;
  const real = inThreadRefresher(() => Promise.reject(new Error("no WFS")), inProcess);
  return {
    refresh: (job, signal, progress) => {
      n++;
      return real(job, signal, progress);
    },
    builds: () => n
  };
}

function boxes(refresh: WfsRefresher, over: Partial<PlanningBoxDeps> = {}) {
  const clock = over.clock ?? fakeClock(NOW);
  const b = new PlanningBoxes({
    dir: path.join(dir, "planning-box"),
    indexDir: path.join(dir, "planning-index"),
    job: () => ({
      config: { radiusKm: 10 },
      cellsDir: CELLS,
      index: () => undefined,
      leafZoom: 16
    }),
    refresh,
    maxKm2: 400,
    boxBusy: () => false,
    clock,
    ...over
  });
  return b;
}

function routeDeps(over: Partial<RouteServiceDeps>): RouteServiceDeps {
  return {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({}),
    vessel: () => ({ draft: 3.6, length: 12, beam: 4 }),
    waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    getRoute: () => Promise.reject(new Error("no routes")),
    now: () => NOW,
    queue: new RequestQueue(),
    ...over
  };
}

async function overRock(p: Prepared | PlanningApiV1) {
  const [a, b]: [LonLat, LonLat] = [
    [ROCK[0] - 0.003, ROCK[1]],
    [ROCK[0] + 0.003, ROCK[1]]
  ];
  const r = await p.session(
    { departure: NOW, until: NOW + 3_600_000, speed: 3 },
    NEVER,
    (s: Session) => Promise.resolve(s.segment(a, b))
  );
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.value;
}

describe("a planning index read back", () => {
  test("after a restart the saved index serves its region and one inside it, with no build", async () => {
    const first = counting();
    const built = await boxes(first.refresh).prepare(REGION, NEVER);
    expect(built.ok).toBe(true);
    expect(first.builds()).toBe(1);
    expect(readHold(path.join(dir, "planning-index"))).toMatchObject({
      region: REGION,
      bbox: planningBbox(REGION),
      builtAt: NOW
    });
    // A new instance over the same directories, as after a restart.
    const again = counting();
    const b = boxes(again.refresh);
    const api = planningApi(
      () => routeDeps({ chartBox: () => FAR }),
      "test",
      () => b
    );
    const r = await api.prepare(INSIDE, NEVER);
    if (!r.ok) {
      throw new Error(r.error);
    }
    expect(again.builds()).toBe(0);
    expect(r.value.coverage).toEqual(planningBbox(REGION));
    // It judges as the index built did: the rock fails the leg over it.
    expect((await overRock(r.value)).status).toBe("fail");
    // Held now: asked again, the same one.
    expect(b.current()?.region).toEqual(REGION);
    const same = await b.prepare(REGION, NEVER);
    expect(same.ok && same.held).toBe(b.current());
    expect(again.builds()).toBe(0);
    b.stop();
  });

  test("released when unused, it is read back rather than built", async () => {
    const c = counting();
    const clock = fakeClock(NOW);
    const b = boxes(c.refresh, { clock });
    await b.prepare(REGION, NEVER);
    b.release();
    expect(b.current()).toBeUndefined();
    const r = await b.prepare(REGION, NEVER);
    expect(r.ok).toBe(true);
    expect(c.builds()).toBe(1);
    b.stop();
  });

  test("a region it does not cover is built, and the record is the new index's", async () => {
    const c = counting();
    const b = boxes(c.refresh);
    await b.prepare(INSIDE, NEVER);
    const wider = await b.prepare(REGION, NEVER);
    expect(wider.ok).toBe(true);
    expect(c.builds()).toBe(2);
    expect(readHold(path.join(dir, "planning-index"))?.region).toEqual(REGION);
    b.stop();
  });

  test("not read back once too old, built at another leaf zoom, or without its record", async () => {
    const indexDir = path.join(dir, "planning-index");
    const c = counting();
    await boxes(c.refresh).prepare(REGION, NEVER);
    const inputs = {
      dir: path.join(dir, "planning-box"),
      indexDir,
      config: { radiusKm: 10 },
      cellsDir: CELLS,
      leafZoom: 16
    };
    expect(restorable(inputs, NOW + 1000)?.region).toEqual(REGION);
    expect(restorable(inputs, NOW + RESTORE_MAX_AGE_MS + 1)).toBeUndefined();
    // A clock set back before the build says nothing of its age.
    expect(restorable(inputs, NOW - 1)).toBeUndefined();
    expect(restorable({ ...inputs, leafZoom: 18 }, NOW + 1000)).toBeUndefined();
    expect(restorable({ ...inputs, source: "another ENC source" }, NOW + 1000)).toBeUndefined();
    // The record names another box than the index in the directory holds.
    const hold = readHold(indexDir);
    writeHold(indexDir, { ...(hold as NonNullable<typeof hold>), bbox: planningBbox(INSIDE) });
    expect(restorable(inputs, NOW + 1000)).toBeUndefined();
    fs.rmSync(holdFile(indexDir));
    expect(restorable(inputs, NOW + 1000)).toBeUndefined();
    // With no record a build is made, as before.
    const later = counting();
    const b = boxes(later.refresh);
    expect((await b.prepare(REGION, NEVER)).ok).toBe(true);
    expect(later.builds()).toBe(1);
    b.stop();
  });

  test("a record that does not parse is no record", () => {
    const indexDir = path.join(dir, "planning-index");
    for (const text of [
      "",
      "{",
      '{"version":2}',
      '{"version":1,"region":[1,2,3],"bbox":[1,2,3,4]}'
    ]) {
      fs.writeFileSync(holdFile(indexDir), text);
      expect(readHold(indexDir)).toBeUndefined();
    }
    const stamp = holdStamp({
      dir,
      indexDir,
      config: { radiusKm: 10 },
      cellsDir: CELLS,
      leafZoom: 16
    });
    expect(typeof stamp).toBe("string");
  });

  test("a build that fails leaves no record of the index it was replacing", async () => {
    const indexDir = path.join(dir, "planning-index");
    await boxes(counting().refresh).prepare(INSIDE, NEVER);
    expect(readHold(indexDir)).toBeDefined();
    const failing: WfsRefresher = () => Promise.reject(new Error("no network"));
    const r = await boxes(failing).prepare(REGION, NEVER);
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(readHold(indexDir)).toBeUndefined();
  });
});

describe("a planning build and its record", () => {
  test("requests that find nothing to read back start one build between them", async () => {
    const c = counting();
    const b = boxes(c.refresh);
    const inside = b.prepare(INSIDE, NEVER);
    const both = await Promise.all([b.prepare(REGION, NEVER), b.prepare(REGION, NEVER)]);
    expect((await inside).ok).toBe(true);
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    expect(c.builds()).toBe(2);
    b.stop();
  });

  test("a stop or an abort while a request looks for a saved index starts no build", async () => {
    const c = counting();
    const stopped = boxes(c.refresh);
    const r = stopped.prepare(REGION, NEVER);
    stopped.stop();
    expect(await r).toMatchObject({ ok: false, status: 503 });
    const controller = new AbortController();
    const b = boxes(c.refresh);
    const a = b.prepare(REGION, controller.signal);
    controller.abort();
    expect((await a).ok).toBe(false);
    expect(c.builds()).toBe(0);
    b.stop();
  });

  test("a record that cannot be removed refuses the build, which would replace its index", async () => {
    const indexDir = path.join(dir, "planning-index");
    fs.mkdirSync(holdFile(indexDir), { recursive: true });
    const c = counting();
    const b = boxes(c.refresh);
    expect(await b.prepare(REGION, NEVER)).toMatchObject({ ok: false, status: 503 });
    expect(c.builds()).toBe(0);
    b.stop();
  });

  test("a cell that changes while the build reads the cells leaves no record", async () => {
    const cells = path.join(dir, "cells");
    fs.cpSync(CELLS, cells, { recursive: true });
    const c = counting();
    const changing: WfsRefresher = async (job, signal, progress) => {
      const r = await c.refresh(job, signal, progress);
      // An update lands after the build read the cell it replaces.
      const later = new Date(NOW + 60_000);
      fs.utimesSync(path.join(cells, "FI5SYNTH.000"), later, later);
      return r;
    };
    const job = () => ({
      config: { radiusKm: 10 },
      cellsDir: cells,
      index: () => undefined,
      leafZoom: 16
    });
    const b = boxes(changing, { job });
    expect((await b.prepare(REGION, NEVER)).ok).toBe(true);
    expect(readHold(path.join(dir, "planning-index"))).toBeUndefined();
    b.stop();
    // Built again, from the cell as it is now; recorded, since nothing changed meanwhile.
    const again = counting();
    const b2 = boxes(again.refresh, { job });
    expect((await b2.prepare(REGION, NEVER)).ok).toBe(true);
    expect(again.builds()).toBe(1);
    expect(readHold(path.join(dir, "planning-index"))?.region).toEqual(REGION);
    b2.stop();
  });
});

describe("prepare with held", () => {
  test("gives what is held or saved, and starts no build: 404 with neither", async () => {
    const c = counting();
    const b = boxes(c.refresh);
    const api = planningApi(
      () => routeDeps({ chartBox: () => FAR }),
      "test",
      () => b
    );
    expect(api.features).toContain("held");
    const none = await api.prepare(REGION, NEVER, undefined, { held: true });
    expect(none).toEqual({ ok: false, status: 404, error: NOT_HELD });
    expect(c.builds()).toBe(0);
    await api.prepare(REGION, NEVER);
    expect(c.builds()).toBe(1);
    const held = await api.prepare(INSIDE, NEVER, undefined, { held: true });
    expect(held.ok && held.value.coverage).toEqual(planningBbox(REGION));
    // Past what is held: nothing, and still no build.
    const past = await api.prepare([22.2, 60.2, 22.3, 60.3], NEVER, undefined, { held: true });
    expect(past).toMatchObject({ ok: false, status: 404 });
    expect(c.builds()).toBe(1);
    // After a restart the saved index is read back for it.
    b.stop();
    const fresh = counting();
    const b2 = boxes(fresh.refresh);
    const r = await b2.heldFor(INSIDE, NEVER);
    expect(r.ok).toBe(true);
    expect(fresh.builds()).toBe(0);
    b2.stop();
  });

  test("the index in use that covers the region is given, as without it", async () => {
    const box: Bbox = [21.9, 59.9, 22.2, 60.1];
    const api = planningApi(() => routeDeps({ chartBox: () => box }), "test");
    const r = await api.prepare(INSIDE, NEVER, undefined, { held: true });
    expect(r.ok && r.value.coverage).toEqual(box);
  });
});

describe("regionGroups", () => {
  const roots = [
    { minX: 1, minY: 1, maxX: 1, maxY: 1 },
    { minX: 1, minY: 2, maxX: 1, maxY: 2 },
    { minX: 2, minY: 1, maxX: 2, maxY: 1 },
    { minX: 2, minY: 2, maxX: 2, maxY: 2 }
  ];

  test("one job of every root on one thread; one per column for a pool", () => {
    expect(regionGroups([0, 1, 2, 3], roots)).toEqual([[0, 1, 2, 3]]);
    expect(regionGroups([0, 1, 2, 3], roots, true, 2)).toEqual([
      [0, 1],
      [2, 3]
    ]);
    expect(regionGroups([], roots, true, 4)).toEqual([]);
  });

  test("with fewer columns than threads, one job per root, so no thread is left idle", () => {
    expect(regionGroups([0, 1, 2, 3], roots, true, 4)).toEqual([[0], [1], [2], [3]]);
    expect(regionGroups([1, 2], roots, true, 3)).toEqual([[1], [2]]);
  });
});
