import fs from "fs";
import path from "path";
import type { LonLat } from "../src/foundation/geo";
import { haversine, project } from "../src/foundation/geo";
import type { Bbox, WfsFetch } from "../src/ingest/wfs";
import type { ChartIndex } from "../src/spatial/chart-index";
import { boxAround, WFS_LIMITS, WFS_SOURCE } from "../src/ingest/wfs";
import { sourceKeys } from "../src/index-loader";
import type { BuildJob } from "../src/spatial/build-worker";
import type { IndexBuilder, WfsBox, WfsServiceDeps } from "../src/wfs-service";
import { inThreadRefresher, WfsService } from "../src/wfs-service";

const TMP = path.join(__dirname, "temp", "wfs-service");
const CHARTS = path.join(TMP, "charts");
const ENC = path.join(CHARTS, "FI5ENC01.000");
const KM_LON_60 = 1 / (111.195 * Math.cos(Math.PI / 3));

function okReply() {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve('{"type":"FeatureCollection","features":[]}')
  });
}

/** Downloads started: each asks the server first how many depth areas the box holds. */
const downloads = (fetched: string[]): number =>
  fetched.filter((u) => {
    const q = new URL(u).searchParams;
    return q.get("typeNames") === "rajoitettu:DepthArea_A" && q.get("resultType") === "hits";
  }).length;

function harness(fetch: WfsFetch = okReply, extra: Partial<WfsServiceDeps> = {}) {
  const t = {
    now: 1_800_000_000_000,
    pos: undefined as LonLat | undefined,
    motion: undefined as { sog: number; cog: number } | undefined,
    /** The index in use: the last one handed over, or one loaded at start. */
    index: undefined as ChartIndex | undefined
  };
  const fetched: string[] = [];
  const built: string[][] = [];
  const indexes: ChartIndex[] = [];
  const handed: (Bbox[] | undefined)[] = [];
  const errors: string[] = [];
  const builder = {
    build: ((job) => {
      built.push(job.dirs);
      return Promise.resolve({ catalogue: { version: 1, cells: [] } } as unknown as ChartIndex);
    }) as IndexBuilder
  };
  const deps: WfsServiceDeps = {
    config: { url: "https://wfs.test/wfs", radiusKm: 10, catzoc: 3 },
    dir: TMP,
    indexDir: path.join(TMP, "index"),
    leafZoom: 20,
    cellsDir: CHARTS,
    inBox: false,
    index: () => t.index,
    refresh: inThreadRefresher(
      (url, init) => {
        fetched.push(url);
        return fetch(url, init);
      },
      (job, signal) => builder.build(job, signal)
    ),
    clock: { now: () => t.now, setInterval: () => 1, clearInterval: () => undefined },
    position: () => t.pos,
    motion: () => t.motion,
    lookahead: { distance: 555.6, minHorizon: 60 },
    onIndex: (i, changed) => {
      indexes.push(i);
      t.index = i;
      handed.push(changed);
    },
    error: (m) => errors.push(m),
    ...extra
  };
  return {
    t,
    fetched,
    built,
    indexes,
    handed,
    errors,
    deps,
    builder,
    service: new WfsService(deps)
  };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(CHARTS, { recursive: true });
  fs.writeFileSync(ENC, "S-57 base cell");
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("WFS box around the vessel", () => {
  test("nothing is fetched before there is a position", async () => {
    const h = harness();
    await h.service.check();
    expect(h.fetched).toHaveLength(0);
  });

  test("the first position downloads a box, rebuilds with the ENC cells first and hands it over", async () => {
    const h = harness();
    h.t.pos = [22.08, 60.07];
    await h.service.check();
    // A count, then one page, per layer.
    expect(h.fetched).toHaveLength(6);
    expect(h.built).toEqual([[ENC, path.join(TMP, "FI1WFS01")]]);
    expect(h.indexes).toHaveLength(1);
    expect(h.service.status().box?.centre).toEqual([22.08, 60.07]);
    expect(h.service.status().notice).toMatch(/not for navigational purposes/);
    expect(fs.existsSync(path.join(TMP, "box.json"))).toBe(true);
  });

  test("the rebuild reuses the saved index's roots that the WFS cell does not reach", async () => {
    const h = harness();
    const changed: (string[] | undefined)[] = [];
    const build = h.builder.build;
    h.builder.build = (job, signal) => {
      changed.push(job.changed);
      return build(job, signal);
    };
    h.t.pos = [22.08, 60.07];
    await h.service.check();
    expect(changed).toEqual([[path.join(TMP, "FI1WFS01")]]);
  });

  test("the box is replaced once the vessel is past half its radius, at most once a minute", async () => {
    const h = harness();
    h.t.pos = [22.08, 60.07];
    await h.service.check();
    h.t.now += 120_000;
    h.t.pos = [22.08 + 4 * KM_LON_60, 60.07];
    await h.service.check();
    expect(h.indexes).toHaveLength(1);
    h.t.pos = [22.08 + 6 * KM_LON_60, 60.07];
    h.t.now -= 90_000;
    await h.service.check();
    expect(h.indexes).toHaveLength(1);
    h.t.now += 90_000;
    await h.service.check();
    expect(h.indexes).toHaveLength(2);
    expect(h.service.status().box?.centre).toEqual([22.08 + 6 * KM_LON_60, 60.07]);
  });

  test("a failed download is reported, keeps the old index and waits five minutes to retry", async () => {
    const h = harness(() =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") })
    );
    h.t.pos = [22.08, 60.07];
    await h.service.check();
    expect(h.indexes).toHaveLength(0);
    expect(h.errors).toEqual(["Traficom WFS depths: rajoitettu:DepthArea_A: HTTP 503"]);
    expect(h.service.status().lastError).toBe("rajoitettu:DepthArea_A: HTTP 503");
    h.t.now += 120_000;
    await h.service.check();
    expect(downloads(h.fetched)).toBe(1);
    h.t.now += 200_000;
    await h.service.check();
    expect(downloads(h.fetched)).toBe(2);
  });

  test("the old and new boxes come with an index only when this run built both", async () => {
    const h = harness();
    h.t.pos = [22.08, 60.07];
    await h.service.check();
    const first = h.service.status().box?.bbox;
    h.t.now += 120_000;
    h.t.pos = [22.08 + 6 * KM_LON_60, 60.07];
    await h.service.check();
    expect(h.handed).toEqual([undefined, [first, h.service.status().box?.bbox]]);
  });

  test("a failed index build is reported in the status and the previous box and index stay", async () => {
    const h = harness();
    h.t.pos = [22.08, 60.07];
    await h.service.check();
    const box = h.service.status().box;
    h.builder.build = () =>
      Promise.reject(new Error("index build stopped at the 256 MB worker heap limit"));
    h.t.now += 120_000;
    h.t.pos = [22.08 + 6 * KM_LON_60, 60.07];
    await h.service.check();
    expect(h.indexes).toHaveLength(1);
    expect(h.service.status()).toMatchObject({
      box,
      busy: false,
      lastError: "index build stopped at the 256 MB worker heap limit"
    });
    expect(h.errors).toEqual([
      "Traficom WFS depths: index build stopped at the 256 MB worker heap limit"
    ]);
  });

  test("stop aborts a download in flight without an error or a new index", async () => {
    const pending: WfsFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      );
    const h = harness(pending);
    h.t.pos = [22.08, 60.07];
    const running = h.service.check();
    h.service.stop();
    await running;
    expect(h.errors).toEqual([]);
    expect(h.indexes).toHaveLength(0);
  });

  test("a stalled server ends the download with the idle timeout in the status", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
    try {
      const h = harness(() => new Promise(() => undefined));
      h.t.pos = [22.08, 60.07];
      const running = h.service.check();
      await jest.advanceTimersByTimeAsync(WFS_LIMITS.idleTimeoutMs + 100);
      await running;
      const why = `rajoitettu:DepthArea_A: no data for ${WFS_LIMITS.idleTimeoutMs / 1000} s`;
      expect(h.service.status()).toMatchObject({ busy: false, lastError: why });
      expect(h.errors).toEqual([`Traficom WFS depths: ${why}`]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("at 25 kn with 10-minute rebuilds each new box arrives before the old one runs out", async () => {
    const h = harness();
    const knots25 = (25 * 1852) / 3600;
    h.t.motion = { sog: knots25, cog: Math.PI / 2 };
    const start: LonLat = [21.5, 60.07];
    const t0 = h.t.now;
    // Each refresh takes 10 virtual minutes, as a z20 rebuild on a Pi 3 does.
    let pending: { at: number; done: () => void } | undefined;
    h.builder.build = () =>
      new Promise((resolve) => {
        pending = {
          at: h.t.now,
          done: () => resolve({ catalogue: { version: 1, cells: [] } } as unknown as ChartIndex)
        };
      });
    const handovers: { inside: number; reach: number }[] = [];
    let box = h.service.status().box;
    for (let s = 0; s <= 2 * 3600; s += 10) {
      h.t.now = t0 + s * 1000;
      h.t.pos = project(start, Math.PI / 2, knots25 * s);
      if (pending && h.t.now - pending.at >= 600_000) {
        pending.done();
        pending = undefined;
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setImmediate(r));
        }
        if (box) {
          // How far inside the old box's east edge the vessel still is.
          const east: LonLat = [box.bbox[2], h.t.pos[1]];
          handovers.push({ inside: haversine(h.t.pos, east), reach: knots25 * 60 });
          expect(h.t.pos[0]).toBeLessThan(box.bbox[2]);
        }
        box = h.service.status().box;
      }
      void h.service.check();
      await new Promise((r) => setImmediate(r));
    }
    expect(handovers.length).toBeGreaterThanOrEqual(10);
    for (const x of handovers) {
      expect(x.inside).toBeGreaterThan(x.reach);
    }
    expect(h.errors).toEqual([]);
  });

  test("the next box is centred ahead along the course, by speed times the last refresh", async () => {
    const h = harness();
    h.t.pos = [22.08, 60.07];
    h.t.motion = { sog: 5, cog: 0 };
    const build = h.builder.build;
    h.builder.build = (job, signal) => {
      h.t.now += 120_000;
      return build(job, signal);
    };
    await h.service.check();
    // No refresh measured yet: 10 minutes assumed, 3 km ahead.
    expect(haversine(h.service.status().box?.centre as LonLat, [22.08, 60.07])).toBeCloseTo(
      3000,
      -2
    );
    expect(h.service.status().box?.durationMs).toBe(120_000);
    h.t.now += 600_000;
    h.t.pos = project([22.08, 60.07], 0, 12_500);
    await h.service.check();
    const c = h.service.status().box?.centre as LonLat;
    expect(haversine(c, h.t.pos)).toBeCloseTo(600, -2);
    expect(c[1]).toBeGreaterThan(h.t.pos[1]);
    // Stopped: the box is centred on the vessel.
    h.t.motion = { sog: 0, cog: 0 };
    h.t.now += 600_000;
    h.t.pos = project([22.08, 60.07], 0, 20_000);
    await h.service.check();
    expect(h.service.status().box?.centre).toEqual(h.t.pos);
  });

  test("after a restart the saved box is reused while the vessel stays inside it", async () => {
    const first = harness();
    first.t.pos = [22.08, 60.07];
    await first.service.check();
    const again = harness();
    again.t.index = first.indexes[0];
    expect(again.service.savedCell()).toBe(path.join(TMP, "FI1WFS01"));
    again.t.pos = [22.08 + 2 * KM_LON_60, 60.07];
    await again.service.check();
    expect(again.fetched).toHaveLength(0);
  });

  test("a saved cell torn by a power cut is left out of the start and downloaded again", async () => {
    const first = harness();
    first.t.pos = [22.08, 60.07];
    await first.service.check();
    fs.writeFileSync(path.join(TMP, "FI1WFS01", "DSID.geojson"), "");
    const again = harness();
    expect(again.service.savedCell()).toBeUndefined();
    expect(again.service.status().lastError).toMatch(/saved cell unreadable/);
    expect(again.errors).toEqual([expect.stringMatching(/saved cell unreadable/)]);
  });
});

describe("box service and the index in use", () => {
  const POS: LonLat = [22.08, 60.07];
  const savedBox = (): WfsBox => ({
    bbox: boxAround(POS, 10),
    centre: POS,
    radiusKm: 10,
    catzoc: 3,
    fetchedAt: "2026-10-20T07:00:00Z",
    features: { depthAreas: 1, dredgedAreas: 0, soundings: 0 }
  });
  const indexOf = (...cells: { name: string; source?: string }[]) =>
    ({ catalogue: { version: 1, cells } }) as unknown as ChartIndex;

  test("a refresh starts before the no-coverage band inside the box edge comes in reach", async () => {
    fs.writeFileSync(
      path.join(TMP, "box.json"),
      JSON.stringify({ ...savedBox(), durationMs: 600_000 })
    );
    const h = harness();
    h.t.index = indexOf({ name: "FI5ENC01" });
    h.t.motion = { sog: 3, cog: Math.PI / 2 };
    // 5.4 km to the east edge: past SOG × 1.5 × 10 min (2.7 km) and the look-ahead (556 m)
    // by 2.1 km, but tiles across the edge flag a footprint up to 1 km plus its buffer inside.
    h.t.pos = project(POS, Math.PI / 2, 4600);
    await h.service.check();
    expect(h.indexes).toHaveLength(1);
  });

  test("a box too small to hold that band is not rebuilt every minute for a drifting vessel", async () => {
    const box = { ...savedBox(), bbox: boxAround(POS, 2), radiusKm: 2, durationMs: 60_000 };
    fs.writeFileSync(path.join(TMP, "box.json"), JSON.stringify(box));
    const h = harness(okReply, { config: { url: "https://wfs.test/wfs", radiusKm: 2, catzoc: 3 } });
    h.t.index = indexOf({ name: "FI5ENC01" });
    h.t.motion = { sog: 0.1, cog: 0 };
    h.t.pos = POS;
    for (let i = 0; i < 5; i++) {
      h.t.now += 120_000;
      await h.service.check();
    }
    expect(h.indexes).toHaveLength(0);
  });

  test("a saved box at the vessel is built again while no index is in use", async () => {
    // As after an upgrade from a whole build, or with the index directory deleted.
    fs.writeFileSync(path.join(TMP, "box.json"), JSON.stringify(savedBox()));
    const h = harness();
    h.t.pos = POS;
    await h.service.check();
    expect(h.indexes).toHaveLength(1);
  });

  test("in box mode a saved box the saved index was not built in is built again", async () => {
    fs.writeFileSync(path.join(TMP, "box.json"), JSON.stringify(savedBox()));
    const h = harness(okReply, { inBox: true });
    h.t.index = indexOf({ name: "FI5ENC01" });
    h.t.pos = POS;
    await h.service.check();
    expect(h.indexes).toHaveLength(1);
    // Once built, the box is kept while the vessel stays inside it.
    h.t.now += 120_000;
    await h.service.check();
    expect(h.indexes).toHaveLength(1);
  });

  test("in box mode an index the start plan recovers after the service is made is kept", async () => {
    fs.writeFileSync(path.join(TMP, "box.json"), JSON.stringify(savedBox()));
    const h = harness(okReply, { inBox: true });
    // A power cut between a commit's two renames left no index directory until the start plan
    // moved `<indexDir>.old-*` back, after the service was made.
    const indexDir = path.join(TMP, "index");
    fs.mkdirSync(indexDir);
    const built = { version: 1, bbox: savedBox().bbox, sources: [] };
    fs.writeFileSync(path.join(indexDir, "box.json"), JSON.stringify(built));
    h.t.index = indexOf({ name: "FI5ENC01" }, { name: "FI1WFS01", source: WFS_SOURCE });
    h.t.pos = POS;
    await h.service.check();
    expect(h.indexes).toHaveLength(0);
  });

  test("the cells are found and stamped by the refresh, after the download", async () => {
    const jobs: BuildJob[] = [];
    const h = harness(okReply, { inBox: true });
    const build = h.builder.build;
    h.builder.build = (job, signal) => {
      jobs.push(job);
      return build(job, signal);
    };
    const refresh = h.deps.refresh;
    const posted: Parameters<typeof refresh>[0][] = [];
    const service = new WfsService({
      ...h.deps,
      refresh: (job, signal) => {
        posted.push(job);
        return refresh(job, signal);
      }
    });
    h.t.pos = POS;
    await service.check();
    // The event loop neither scans the cells directory nor stamps a cell.
    expect(posted[0]).toMatchObject({ cellsDir: CHARTS, box: expect.any(Array) });
    expect(posted[0]?.build).toEqual({
      dirs: [path.join(TMP, "FI1WFS01")],
      leafZoom: 20,
      indexDir: path.join(TMP, "index")
    });
    const dirs = [ENC, path.join(TMP, "FI1WFS01")];
    expect(jobs[0]?.dirs).toEqual(dirs);
    // The new WFS cell is stamped by its downloaded edition, so the next start keeps the index.
    expect(jobs[0]?.box?.sources).toEqual(sourceKeys(dirs));
    expect(jobs[0]?.box?.sources).toContain("FI1WFS01 edition 1 update 0");
  });

  test("a missing cells directory fails the refresh, which is retried once it is back", async () => {
    fs.rmSync(CHARTS, { recursive: true });
    const h = harness(okReply, { config: { radiusKm: 10 }, inBox: true });
    h.t.pos = POS;
    await expect(h.service.check()).resolves.toBeUndefined();
    expect(h.service.status()).toMatchObject({
      busy: false,
      lastError: expect.stringMatching(/ENOENT/)
    });
    expect(h.errors).toEqual([expect.stringMatching(/^chart box around the vessel: ENOENT/)]);
    fs.mkdirSync(CHARTS);
    fs.writeFileSync(ENC, "S-57 base cell");
    h.t.now += 300_000;
    await h.service.check();
    expect(h.built).toEqual([[ENC]]);
  });

  test("a check that throws is reported, never left an unhandled rejection", async () => {
    const h = harness(okReply, {
      position: () => {
        throw new Error("no navigation data");
      }
    });
    h.service.start();
    await new Promise((r) => setImmediate(r));
    expect(h.errors).toEqual(["Traficom WFS depths: no navigation data"]);
  });

  test("an empty cells directory keeps the ENC index in use", async () => {
    fs.rmSync(ENC);
    const box = harness(okReply, { config: { radiusKm: 10 }, inBox: true });
    box.t.index = indexOf({ name: "FI5ENC01" });
    box.t.pos = POS;
    await box.service.check();
    expect(box.built).toEqual([]);
    expect(box.errors).toEqual([`chart box around the vessel: no S-57 cell found in ${CHARTS}`]);
    // With the WFS on, an index of ENC cells is kept too, but WFS depths alone are rebuilt.
    const wfs = harness();
    wfs.t.index = indexOf({ name: "FI5ENC01" }, { name: "FI1WFS01", source: WFS_SOURCE });
    wfs.t.pos = POS;
    await wfs.service.check();
    expect(wfs.built).toEqual([]);
    const alone = harness();
    alone.t.index = indexOf({ name: "FI1WFS01", source: WFS_SOURCE });
    alone.t.pos = POS;
    await alone.service.check();
    expect(alone.built).toEqual([[path.join(TMP, "FI1WFS01")]]);
  });
});
