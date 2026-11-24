import fs from "fs";
import os from "os";
import path from "path";
import type { WfsFetch } from "../../src/ingest/wfs";
import { downloadWfsCell } from "../../src/ingest/wfs";

/**
 * The FTIA's navigation lines and swept areas are read beside the Traficom depths
 * (`fairwayLayers`, `ingest/wfs-ftia.ts`), not after them.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-wfs-fairways-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const page = (features: unknown[]) => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify({ type: "FeatureCollection", features }))
});

const line = {
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [21.975, 60],
      [22.005, 60]
    ]
  },
  properties: {
    navigointilinjaid: 1,
    mitoitussyvays: 2.1,
    haraussyvyys: 2.7,
    vertaustaso: "MW2020"
  }
};

const download = (fetch: WfsFetch, signal?: AbortSignal) =>
  downloadWfsCell({
    fetch,
    url: "https://wfs.test/wfs",
    linesUrl: "https://ftia.test/ows",
    bbox: [21.95, 59.95, 22.05, 60.05],
    dir: path.join(TMP, "FI1WFS01"),
    now: new Date("2026-10-18T07:00:00Z"),
    ...(signal && { signal })
  });

const ftia = (url: string): boolean => url.startsWith("https://ftia.test/");
const lines = (url: string): boolean => url.includes("navigointilinjat");
const first = (url: string): boolean => new URL(url).searchParams.get("startIndex") === "0";

describe("the FTIA's layers beside the depths", () => {
  test("both are asked for while the depths have yet to answer, and the cell holds them", async () => {
    const asked: string[] = [];
    let release: () => void = () => undefined;
    const depthsHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch: WfsFetch = async (url) => {
      asked.push(url);
      if (ftia(url)) {
        return page(lines(url) && first(url) ? [line] : []);
      }
      await depthsHeld;
      return page([]);
    };
    const done = download(fetch);
    await new Promise((r) => setImmediate(r));
    expect(asked.some((u) => lines(u))).toBe(true);
    expect(asked.some((u) => u.includes("vaylaalueet"))).toBe(true);
    release();
    expect(await done).toMatchObject({ lines: 1 });
  });

  test("a depth layer that fails is the download's error, and ends the FTIA's reads", async () => {
    const signals: AbortSignal[] = [];
    const fetch: WfsFetch = (url, init) => {
      if (ftia(url)) {
        if (init?.signal) {
          signals.push(init.signal);
        }
        // Never answers: only the abort ends it.
        return new Promise(() => undefined);
      }
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("") });
    };
    await expect(download(fetch)).rejects.toThrow(/HTTP 500/);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  test("the FTIA's WFS failing leaves a cell without lines, as before", async () => {
    const fetch: WfsFetch = (url) =>
      Promise.resolve(
        ftia(url) ? { ok: false, status: 500, text: () => Promise.resolve("") } : page([])
      );
    expect(await download(fetch)).toMatchObject({ lines: false, dredgedAreas: 0 });
  });
});
