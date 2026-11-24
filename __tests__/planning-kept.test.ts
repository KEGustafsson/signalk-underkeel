import fs from "fs";
import os from "os";
import path from "path";
import { toMercator } from "../src/foundation/geo";
import type { Bbox } from "../src/ingest/wfs";
import type { PlanningBoxDeps } from "../src/planning-box";
import { PlanningBoxes } from "../src/planning-box";
import { KEPT } from "../src/planning-kept";
import { readHold } from "../src/planning-restore";
import { runBuild } from "../src/spatial/build-worker";
import { commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import { minDepthOver } from "../src/spatial/pyramid";
import type { IndexBuilder, WfsRefresher } from "../src/wfs-service";
import { inThreadRefresher } from "../src/wfs-service";
import { CELLS, prepareFixtureIndex, ROCK } from "./helpers/fixture-index";
import { fakeClock } from "./helpers/plugin-harness";

/**
 * Planning indexes kept beside the one on disk (`planning-kept.ts`): a region built before the
 * one a later build left in the planning index directory is read back, not built again.
 */

beforeAll(prepareFixtureIndex);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-kept-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-18T07:00:00Z");
const NEVER = new AbortController().signal;
const [X, Y] = ROCK;
const WEST: Bbox = [X - 0.02, Y - 0.01, X - 0.001, Y + 0.01];
const EAST: Bbox = [X + 0.001, Y - 0.01, X + 0.02, Y + 0.01];
const BOTH: Bbox = [X - 0.02, Y - 0.01, X + 0.02, Y + 0.01];
/** Boxes side by side, none covering another. */
const strip = (k: number): Bbox => [
  X - 0.02 + k * 0.005,
  Y - 0.01,
  X - 0.016 + k * 0.005,
  Y + 0.01
];

const inProcess: IndexBuilder = async (job) => {
  const r = await runBuild({ ...job, threads: 1 });
  commitChartIndex(job.indexDir, r.staging);
  return loadChartIndex(job.indexDir);
};

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

const clock = fakeClock(NOW);

function boxes(refresh: WfsRefresher, over: Partial<PlanningBoxDeps> = {}) {
  return new PlanningBoxes({
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
}

/** Builds or reads back `region` a second after the last, and gives what is held. */
async function ask(b: PlanningBoxes, region: Bbox) {
  clock.advance(1000);
  const r = await b.prepare(region, NEVER);
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.held;
}

const keptNames = (): string[] =>
  fs.existsSync(path.join(dir, "planning-index.kept"))
    ? fs.readdirSync(path.join(dir, "planning-index.kept")).filter((n) => /^\d+$/.test(n))
    : [];

/** What the index reads on a short line through the middle of `region`. */
function middle(index: Parameters<typeof minDepthOver>[0], region: Bbox) {
  const [x, y] = [(region[0] + region[2]) / 2, (region[1] + region[3]) / 2];
  const r = minDepthOver(index, {
    type: "line",
    coords: [toMercator(x - 0.0005, y), toMercator(x + 0.0005, y)]
  });
  return { dMin: r.dMin, flags: r.flags };
}

describe("planning indexes kept beside the one on disk", () => {
  test("a region built before another is read back, the same index, also after a restart", async () => {
    const c = counting();
    const b = boxes(c.refresh);
    const first = await ask(b, WEST);
    const built = middle(first.index.pyramid, WEST);
    await ask(b, EAST);
    expect(c.builds()).toBe(2);
    const back = await ask(b, WEST);
    expect(c.builds()).toBe(2);
    expect(back.region).toEqual(WEST);
    expect(middle(back.index.pyramid, WEST)).toEqual(built);
    // The index a build left in the planning index directory is read back from there.
    expect((await ask(b, EAST)).region).toEqual(EAST);
    expect(c.builds()).toBe(2);
    b.stop();
    const again = counting();
    const restarted = boxes(again.refresh);
    expect((await ask(restarted, WEST)).region).toEqual(WEST);
    expect((await ask(restarted, EAST)).region).toEqual(EAST);
    expect(again.builds()).toBe(0);
    restarted.stop();
  });

  test("at most KEPT are kept: the one built first goes, and is built again when asked for", async () => {
    const c = counting();
    const b = boxes(c.refresh);
    for (let k = 0; k < KEPT + 2; k++) {
      await ask(b, strip(k));
    }
    expect(c.builds()).toBe(KEPT + 2);
    expect(keptNames()).toHaveLength(KEPT);
    await ask(b, strip(1));
    expect(c.builds()).toBe(KEPT + 2);
    await ask(b, strip(0));
    expect(c.builds()).toBe(KEPT + 3);
    b.stop();
  });

  test("a kept index a later one covers is removed", async () => {
    const c = counting();
    const b = boxes(c.refresh);
    await ask(b, WEST);
    await ask(b, BOTH);
    expect(keptNames()).toHaveLength(1);
    // BOTH is kept now, and covers WEST.
    await ask(b, [X + 0.03, Y - 0.01, X + 0.04, Y + 0.01]);
    expect(keptNames()).toHaveLength(1);
    const only = path.join(dir, "planning-index.kept", keptNames()[0] as string);
    expect(readHold(only)?.region).toEqual(BOTH);
    b.stop();
  });

  test("a kept index is not read back for a build at another leaf zoom", async () => {
    const c = counting();
    const b = boxes(c.refresh);
    await ask(b, WEST);
    await ask(b, EAST);
    b.stop();
    const other = counting();
    const finer = boxes(other.refresh, {
      job: () => ({
        config: { radiusKm: 10 },
        cellsDir: CELLS,
        index: () => undefined,
        leafZoom: 17
      })
    });
    await ask(finer, WEST);
    expect(other.builds()).toBe(1);
    finer.stop();
  });

  test("a build that fails leaves the index it was replacing to be read back", async () => {
    const c = counting();
    await ask(boxes(c.refresh), WEST);
    const failing: WfsRefresher = () => Promise.reject(new Error("no network"));
    const r = await boxes(failing).prepare(EAST, NEVER);
    expect(r).toMatchObject({ ok: false, status: 503 });
    const after = counting();
    const b = boxes(after.refresh);
    expect((await ask(b, WEST)).region).toEqual(WEST);
    expect(after.builds()).toBe(0);
    b.stop();
  });

  test("a copy cut short, or a directory without its record, is no index and is removed", async () => {
    const root = path.join(dir, "planning-index.kept");
    const c = counting();
    const b = boxes(c.refresh);
    await ask(b, WEST);
    fs.mkdirSync(path.join(root, "123.partial"), { recursive: true });
    fs.mkdirSync(path.join(root, "456"), { recursive: true });
    await ask(b, EAST);
    expect(fs.readdirSync(root).sort()).toEqual(
      [...keptNames(), ...keptNames().map((n) => `${n}.held.json`)].sort()
    );
    expect(keptNames()).toHaveLength(1);
    b.stop();
  });
});
