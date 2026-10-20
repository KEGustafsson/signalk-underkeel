import fs from "fs";
import path from "path";
import type { LonLat } from "../src/foundation/geo";
import type { WfsFetch } from "../src/ingest/wfs";
import type { ChartIndex } from "../src/spatial/chart-index";
import { WFS_LIMITS } from "../src/ingest/wfs";
import type { IndexBuilder, WfsServiceDeps } from "../src/wfs-service";
import { inThreadRefresher, WfsService } from "../src/wfs-service";

const TMP = path.join(__dirname, "temp", "wfs-service");
const KM_LON_60 = 1 / (111.195 * Math.cos(Math.PI / 3));

function okReply() {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve('{"type":"FeatureCollection","features":[]}')
  });
}

function harness(fetch: WfsFetch = okReply) {
  const t = { now: 1_800_000_000_000, pos: undefined as LonLat | undefined };
  const fetched: string[] = [];
  const built: string[][] = [];
  const indexes: ChartIndex[] = [];
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
    encDirs: () => ["/charts/FI5ENC01"],
    refresh: inThreadRefresher(
      (url, init) => {
        fetched.push(url);
        return fetch(url, init);
      },
      (job, signal) => builder.build(job, signal)
    ),
    clock: { now: () => t.now, setInterval: () => 1, clearInterval: () => undefined },
    position: () => t.pos,
    onIndex: (i) => indexes.push(i),
    error: (m) => errors.push(m)
  };
  return { t, fetched, built, indexes, errors, deps, builder, service: new WfsService(deps) };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
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
    expect(h.fetched).toHaveLength(3);
    expect(h.built).toEqual([["/charts/FI5ENC01", path.join(TMP, "FI1WFS01")]]);
    expect(h.indexes).toHaveLength(1);
    expect(h.service.status().box?.centre).toEqual([22.08, 60.07]);
    expect(h.service.status().notice).toMatch(/not for navigational purposes/);
    expect(fs.existsSync(path.join(TMP, "box.json"))).toBe(true);
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
    expect(h.fetched).toHaveLength(1);
    h.t.now += 200_000;
    await h.service.check();
    expect(h.fetched).toHaveLength(2);
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

  test("after a restart the saved box is reused while the vessel stays inside it", async () => {
    const first = harness();
    first.t.pos = [22.08, 60.07];
    await first.service.check();
    const again = harness();
    expect(again.service.savedCell()).toBe(path.join(TMP, "FI1WFS01"));
    again.t.pos = [22.08 + 2 * KM_LON_60, 60.07];
    await again.service.check();
    expect(again.fetched).toHaveLength(0);
  });
});
