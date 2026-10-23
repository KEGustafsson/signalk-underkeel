import fs from "fs";
import path from "path";
import { haversine } from "../../src/foundation/geo";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { WfsFetch } from "../../src/ingest/wfs";
import {
  bboxProblem,
  boxAround,
  clipRing,
  downloadWfsCell,
  WFS_LIMITS
} from "../../src/ingest/wfs";

const TMP = path.join(__dirname, "..", "temp", "wfs-ingest");
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function reply(features: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ type: "FeatureCollection", features, ...extra }))
  };
}

const area = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [21.9, 59.9],
        [22.1, 59.9],
        [22.1, 60.1],
        [21.9, 60.1],
        [21.9, 59.9]
      ]
    ]
  },
  properties: { DRVAL1: "3", DRVAL2: "6", IDENTIFIER: "FI 3" }
};
const sounding = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [22.0, 60.0, 0] },
  properties: { DEPTH: 4.2, IDENTIFIER: "FI 4" }
};

describe("Traficom WFS ingest", () => {
  test("the box around the vessel reaches the radius on every side", () => {
    const b = boxAround([22, 60], 10);
    expect(haversine([22, 60], [22, b[3]])).toBeCloseTo(10000, -1);
    expect(haversine([22, 60], [b[2], 60])).toBeCloseTo(10000, -1);
    expect(bboxProblem(b)).toBeUndefined();
    expect(bboxProblem(boxAround([22, 60], WFS_LIMITS.maxRadiusKm))).toBeUndefined();
    expect(bboxProblem([22, 60, 23, 61])).toMatch(/at most/);
    expect(bboxProblem([22, 60, 21, 61])).toMatch(/west < east/);
  });

  test("a ring is clipped to the box and a ring outside it vanishes", () => {
    const ring = clipRing(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0]
      ],
      [5, -1, 20, 5]
    );
    // Closed, and exactly the part of the square inside the box.
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const corners = ring
      .slice(0, -1)
      .map((p) => p.join(","))
      .sort();
    expect(corners).toEqual(["10,0", "10,5", "5,0", "5,5"]);
    expect(
      clipRing(
        [
          [30, 30],
          [31, 30],
          [31, 31],
          [30, 30]
        ],
        [0, 0, 10, 10]
      )
    ).toEqual([]);
  });

  test("the download asks for the box in lat, lon order and writes a readable cell", async () => {
    const urls: string[] = [];
    const fetch: WfsFetch = (url) => {
      urls.push(url);
      if (new URL(url).searchParams.get("startIndex") !== "0") {
        return Promise.resolve(reply([]));
      }
      if (url.includes("DepthArea_A")) {
        return Promise.resolve(reply([area]));
      }
      return Promise.resolve(reply(url.includes("Sounding_P") ? [sounding] : []));
    };
    const dir = path.join(TMP, "FI1WFS01");
    const counts = await downloadWfsCell({
      fetch,
      url: "https://wfs.test/wfs",
      bbox: [21.95, 59.95, 22.05, 60.05],
      dir,
      now: new Date("2026-10-18T07:00:00Z"),
      catzoc: 3
    });
    expect(counts).toEqual({ depthAreas: 1, dredgedAreas: 0, soundings: 1 });
    const q = new URL(urls[0] as string).searchParams;
    expect(q.get("bbox")).toBe("59.95,21.95,60.05,22.05,urn:ogc:def:crs:EPSG::4326");
    expect(q.get("srsName")).toBe("EPSG:4326");
    const cell = readCellDirectory(dir, 3);
    expect(cell.info).toMatchObject({
      name: "FI1WFS01",
      band: 1,
      source: "traficom-wfs",
      issueDate: "20261018"
    });
    expect(cell.features.every((f) => f.advisory === true)).toBe(true);
    const roles = cell.features.map((f) => f.role).sort();
    expect(roles).toEqual(["coverage", "depth", "depth", "quality"]);
    expect(cell.features.find((f) => f.role === "quality")).toMatchObject({
      catzoc: 3,
      lnam: "WFS-QUAL-ASSUMED"
    });
    const depths = cell.features.flatMap((f) => (f.role === "depth" ? [f.depth] : [])).sort();
    expect(depths).toEqual([3, 4.2]);
  });

  test("pages are fetched until one comes back empty", async () => {
    const starts: string[] = [];
    const fetch: WfsFetch = (url) => {
      const start = new URL(url).searchParams.get("startIndex") as string;
      starts.push(start);
      const pages = url.includes("Sounding_P")
        ? { "0": WFS_LIMITS.pageSize, [String(WFS_LIMITS.pageSize)]: 1 }
        : { "0": 1 };
      const n = (pages as Record<string, number>)[start] ?? 0;
      return Promise.resolve(reply(Array.from({ length: n }, () => sounding)));
    };
    const counts = await downloadWfsCell({
      fetch,
      url: "https://wfs.test/wfs",
      bbox: [21.95, 59.95, 22.05, 60.05],
      dir: path.join(TMP, "paged"),
      now: new Date()
    });
    expect(counts.soundings).toBe(WFS_LIMITS.pageSize + 1);
    expect(starts).toContain(String(WFS_LIMITS.pageSize));
  });

  test("a server that caps its pages below the asked count is read to the end", async () => {
    // Pages of 3, as from a server whose own limit is below WFS_LIMITS.pageSize.
    const read = async (matched: boolean): Promise<number> => {
      const fetch: WfsFetch = (url) => {
        const start = Number(new URL(url).searchParams.get("startIndex"));
        const n = url.includes("Sounding_P") ? Math.max(0, Math.min(3, 7 - start)) : 0;
        const features = Array.from({ length: n }, () => sounding);
        return Promise.resolve(reply(features, matched ? { numberMatched: 7 } : {}));
      };
      const counts = await downloadWfsCell({
        fetch,
        url: "https://wfs.test/wfs",
        bbox: [21.95, 59.95, 22.05, 60.05],
        dir: path.join(TMP, `capped-${String(matched)}`),
        now: new Date()
      });
      return counts.soundings;
    };
    expect(await read(true)).toBe(7);
    expect(await read(false)).toBe(7);
  });

  test("a server that ignores startIndex is refused after maxPages pages", async () => {
    const fetch: WfsFetch = () => Promise.resolve(reply([sounding]));
    await expect(
      downloadWfsCell({
        fetch,
        url: "https://wfs.test/wfs",
        bbox: [21.95, 59.95, 22.05, 60.05],
        dir: path.join(TMP, "endless"),
        now: new Date()
      })
    ).rejects.toThrow(`more than ${WFS_LIMITS.maxPages} pages`);
  });

  test("an HTTP error or an oversize box fails and leaves the previous cell", async () => {
    const dir = path.join(TMP, "kept");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker"), "old");
    const failing: WfsFetch = () =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") });
    const d = { url: "https://wfs.test/wfs", dir, now: new Date() };
    await expect(
      downloadWfsCell({ ...d, fetch: failing, bbox: [21.95, 59.95, 22.05, 60.05] })
    ).rejects.toThrow("rajoitettu:DepthArea_A: HTTP 503");
    await expect(downloadWfsCell({ ...d, fetch: failing, bbox: [20, 59, 23, 61] })).rejects.toThrow(
      /at most/
    );
    expect(fs.readFileSync(path.join(dir, "marker"), "utf8")).toBe("old");
  });

  describe("with a count from a hits request, pages are read side by side", () => {
    const BOX: [number, number, number, number] = [21.95, 59.95, 22.05, 60.05];
    const numbered = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...sounding, id: `Sounding_P.${i}` }));
    /** A server holding `soundings` that answers hits, and pages by startIndex and count. */
    const server = (soundings: unknown[], o: { matched?: number; ignoreStart?: boolean } = {}) => {
      const log = { urls: [] as string[], inFlight: 0, maxInFlight: 0 };
      const fetch: WfsFetch = async (url) => {
        log.urls.push(url);
        log.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        log.inFlight--;
        const q = new URL(url).searchParams;
        const all = url.includes("Sounding_P") ? soundings : [];
        if (q.get("resultType") === "hits") {
          const text = `<wfs:FeatureCollection numberMatched="${url.includes("Sounding_P") ? (o.matched ?? all.length) : 0}" numberReturned="0"/>`;
          return { ok: true, status: 200, text: () => Promise.resolve(text) };
        }
        const start = o.ignoreStart ? 0 : Number(q.get("startIndex"));
        return reply(all.slice(start, start + Number(q.get("count"))));
      };
      return { fetch, log };
    };
    const download = (fetch: WfsFetch, dir: string) =>
      downloadWfsCell({
        fetch,
        url: "https://wfs.test/wfs",
        bbox: BOX,
        dir: path.join(TMP, dir),
        now: new Date()
      });

    test("every feature is read once, in order, with at most `concurrency` requests at once", async () => {
      const n = 2 * WFS_LIMITS.pageSize + 7;
      const { fetch, log } = server(numbered(n));
      await expect(download(fetch, "counted")).resolves.toMatchObject({ soundings: n });
      expect(log.maxInFlight).toBeLessThanOrEqual(WFS_LIMITS.concurrency);
      const pages = log.urls
        .map((u) => new URL(u).searchParams)
        .filter((q) => q.get("typeNames") === "rajoitettu:Sounding_P" && q.has("startIndex"));
      expect(pages.every((q) => q.get("sortBy") === "IDENTIFIER")).toBe(true);
      expect(pages.every((q) => Number(q.get("count")) <= WFS_LIMITS.pageSize)).toBe(true);
      const written = JSON.parse(
        fs.readFileSync(path.join(TMP, "counted", "SOUNDG.geojson"), "utf8")
      ) as { features: unknown[] };
      expect(written.features).toHaveLength(n);
    });

    test("a count above maxFeatures is refused before any page is fetched", async () => {
      const { fetch, log } = server([], { matched: WFS_LIMITS.maxFeatures + 1 });
      await expect(download(fetch, "too-many")).rejects.toThrow(
        `more than ${WFS_LIMITS.maxFeatures} features`
      );
      expect(log.urls.every((u) => new URL(u).searchParams.get("resultType") === "hits")).toBe(
        true
      );
    });

    test("fewer features than counted fail the download", async () => {
      const { fetch } = server(numbered(10), { matched: 12 });
      await expect(download(fetch, "short")).rejects.toThrow(
        "rajoitettu:Sounding_P: 10 features read, 12 matched"
      );
    });

    test("a server that ignores startIndex fails on the repeated features", async () => {
      const { fetch } = server(numbered(40), { ignoreStart: true });
      await expect(download(fetch, "repeated")).rejects.toThrow(
        "rajoitettu:Sounding_P: the same feature on more than one page"
      );
    });
  });

  describe("page bodies are streamed with a byte cap and an idle timeout", () => {
    const BOX: [number, number, number, number] = [21.95, 59.95, 22.05, 60.05];
    const download = (fetch: WfsFetch, dir: string, signal?: AbortSignal) =>
      downloadWfsCell({
        fetch,
        url: "https://wfs.test/wfs",
        bbox: BOX,
        dir: path.join(TMP, dir),
        now: new Date(),
        signal
      });
    /** A body sending `chunks` pieces of `text`, each `everyMs` apart, then open or closed. */
    const streamed = (text: string, chunks: number, everyMs: number, close = true) => {
      const bytes = new TextEncoder().encode(text);
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull: (c) =>
          new Promise<void>((resolve) => {
            if (sent === chunks) {
              if (close) {
                c.close();
              }
              return;
            }
            setTimeout(() => {
              const step = Math.ceil(bytes.length / chunks);
              c.enqueue(bytes.subarray(sent * step, (sent + 1) * step));
              sent++;
              resolve();
            }, everyMs);
          })
      });
    };
    const body = (stream: ReadableStream<Uint8Array>) => ({
      ok: true,
      status: 200,
      body: stream,
      text: () => Promise.reject(new Error("read the body stream instead"))
    });
    const empty = () => JSON.stringify({ type: "FeatureCollection", features: [] });

    afterEach(() => jest.useRealTimers());

    test("a page larger than the cap fails the download and leaves the previous cell", async () => {
      const dir = path.join(TMP, "capped-page");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "marker"), "old");
      // 1 MB chunks of one shared buffer, never closed: only the cap ends it.
      const mb = new Uint8Array(2 ** 20).fill(32);
      let cancelled = false;
      const huge = () =>
        new ReadableStream<Uint8Array>({
          pull: (c) => c.enqueue(mb),
          cancel: () => {
            cancelled = true;
          }
        });
      await expect(download(() => Promise.resolve(body(huge())), "capped-page")).rejects.toThrow(
        `rajoitettu:DepthArea_A: page larger than ${WFS_LIMITS.maxPageBytes / 2 ** 20} MB; use a smaller box`
      );
      expect(cancelled).toBe(true);
      expect(fs.readFileSync(path.join(dir, "marker"), "utf8")).toBe("old");
    });

    test("a body that stops sending fails after the idle timeout", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
      const running = download(
        () => Promise.resolve(body(streamed('{"type":"FeatureCollection",', 2, 10, false))),
        "idle"
      );
      const failed = expect(running).rejects.toThrow(
        `rajoitettu:DepthArea_A: no data for ${WFS_LIMITS.idleTimeoutMs / 1000} s`
      );
      await jest.advanceTimersByTimeAsync(WFS_LIMITS.idleTimeoutMs + 100);
      await failed;
    });

    test("a server that does not answer at all fails after the idle timeout", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
      // Ignores the signal, as a hung proxy might.
      const running = download(() => new Promise(() => undefined), "silent");
      const failed = expect(running).rejects.toThrow(
        `rajoitettu:DepthArea_A: no data for ${WFS_LIMITS.idleTimeoutMs / 1000} s`
      );
      await jest.advanceTimersByTimeAsync(WFS_LIMITS.idleTimeoutMs + 100);
      await failed;
    });

    test("a slow body that keeps sending is read to the end, however long it takes", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
      const text = JSON.stringify({ type: "FeatureCollection", features: [area] });
      // 12 pieces 20 s apart: 4 minutes for the page, never 30 s without data.
      const fetch: WfsFetch = (url) =>
        Promise.resolve(
          url.includes("DepthArea_A") && new URL(url).searchParams.get("startIndex") === "0"
            ? body(streamed(text, 12, 20_000))
            : body(streamed(empty(), 1, 0))
        );
      const running = download(fetch, "slow");
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      await expect(running).resolves.toMatchObject({ depthAreas: 1 });
    });

    test("stop aborts a body being read without the idle reason", async () => {
      const stop = new AbortController();
      const running = download(
        () => Promise.resolve(body(streamed("{", 2, 5, false))),
        "stopped",
        stop.signal
      );
      setTimeout(() => stop.abort(new Error("aborted")), 30);
      await expect(running).rejects.toThrow("aborted");
    });
  });
});
