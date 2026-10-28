import { execFile } from "child_process";
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { cellSources, sourceKeys } from "../src/index-loader";
import { boxAround } from "../src/ingest/wfs";
import { readBox } from "../src/spatial/build-box";
import { builtReply } from "../src/spatial/build-worker";
import { commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import type { WfsJob, WfsReply } from "../src/wfs-worker";
import { CELLS, FIXTURES } from "./helpers/fixture-index";

/**
 * The Traficom WFS refresh worker (PL4): download, parse, clip, cell write and index build
 * all off the main thread. The job runs in-process; the child process needs the compiled lib/,
 * which `npm run build` makes. The WFS is a local HTTP server.
 */

const LIB_SERVICE = path.resolve(__dirname, "..", "lib", "wfs-service.js");
const LIB_WORKER = path.resolve(__dirname, "..", "lib", "wfs-worker.js");

const BOX = boxAround([22.05, 60.01], 3);
const AREA = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [21.9, 59.9],
        [22.2, 59.9],
        [22.2, 60.1],
        [21.9, 60.1],
        [21.9, 59.9]
      ]
    ]
  },
  properties: { DRVAL1: "10", IDENTIFIER: "FI 10" }
};
const collection = (features: unknown[]) =>
  Buffer.from(
    JSON.stringify({ type: "FeatureCollection", features, numberMatched: features.length })
  );

/** Serves `depthAreas` for DepthArea_A and nothing for the other layers. */
async function wfsServer(depthAreas: Buffer): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const first = q.get("startIndex") === "0" && (q.get("typeNames") ?? "").includes("DepthArea");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(first ? depthAreas : collection([]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/wfs`, close: () => server.close() };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-wfs-worker-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function job(url: string): WfsJob {
  const cell = path.join(dir, "wfs", "FI1WFS01");
  return {
    download: { url, bbox: BOX, dir: cell, now: "2026-10-20T07:00:00Z", catzoc: 3 },
    build: {
      dirs: [path.join(FIXTURES, "FI5SYNTH"), cell],
      leafZoom: 16,
      indexDir: path.join(dir, "index")
    }
  };
}

describe("WFS refresh job", () => {
  test("downloads the box, writes the cell and stages an index for the main thread", async () => {
    const wfs = await wfsServer(collection([AREA]));
    try {
      const j = job(wfs.url);
      const { runWfsJob } = await import("../src/wfs-worker");
      const r = await runWfsJob({ ...j, build: { ...j.build, threads: 1 } }, globalThis.fetch);
      expect({ ...builtReply(r), features: r.features } satisfies WfsReply).toEqual({
        ok: true,
        staging: expect.any(String),
        index: expect.objectContaining({ leafZoom: 16 }),
        features: { depthAreas: 1, dredgedAreas: 0, soundings: 0 }
      });
      expect(fs.existsSync(j.build.indexDir)).toBe(false);
      commitChartIndex(j.build.indexDir, r.staging);
      expect(loadChartIndex(j.build.indexDir).catalogue.cells.map((c) => c.name)).toEqual([
        "FI5SYNTH",
        "FI1WFS01"
      ]);
    } finally {
      wfs.close();
    }
  });
});

describe("WFS box refresh with S-57 cells", () => {
  test("finds the cells and stamps every source after the download, off the event loop", async () => {
    const wfs = await wfsServer(collection([AREA]));
    try {
      const cell = path.join(dir, "wfs", "FI1WFS01");
      const { runWfsJob } = await import("../src/wfs-worker");
      const r = await runWfsJob(
        {
          ...job(wfs.url),
          cellsDir: CELLS,
          cellsRequired: true,
          box: BOX,
          build: { dirs: [cell], leafZoom: 16, indexDir: path.join(dir, "index"), threads: 1 }
        },
        globalThis.fetch
      );
      expect(r.index.catalogue.cells.map((c) => c.name)).toEqual([
        "FI4SYNTH",
        "FI5SYNTH",
        "FI1WFS01"
      ]);
      // Stamped before the download, the new cell would read as edition 0 and the next start
      // would rebuild the index for a change that never happened.
      const sources = sourceKeys([...cellSources(CELLS), cell]);
      expect(readBox(r.staging)).toEqual({ bbox: BOX, sources, leafZoom: 16 });
      expect(sources).toContain("FI1WFS01 edition 1 update 0");
    } finally {
      wfs.close();
    }
  });

  test("an empty cells directory fails before anything is downloaded", async () => {
    const empty = path.join(dir, "cells");
    fs.mkdirSync(empty);
    const fetched: string[] = [];
    const { runWfsJob } = await import("../src/wfs-worker");
    await expect(
      runWfsJob({ ...job("http://wfs.test/wfs"), cellsDir: empty, cellsRequired: true }, (url) => {
        fetched.push(url);
        return Promise.reject(new Error("no network"));
      })
    ).rejects.toThrow(`no S-57 cell found in ${empty}`);
    expect(fetched).toEqual([]);
  });
});

/**
 * Serves a 30 MB page from a fresh process and runs `workerRefresher` there, ticking every 5 ms
 * on its main thread. Run inside Jest, the longest pause counted the collector on the runner's
 * own heap: 181 ms late in a coverage run, against 100 ms. Prints the longest pause, the
 * page's length and what the refresh returned.
 */
const PAUSE_PROBE = `
const http = require("http");
const [libService, area, jobJson] = process.argv.slice(1);
const { workerRefresher } = require(libService);
const AREA = JSON.parse(area);
const collection = (features) =>
  Buffer.from(JSON.stringify({ type: "FeatureCollection", features, numberMatched: features.length }));
// Bulky attributes the cell does not keep: the page is large, the index small.
const pad = Array.from({ length: 20000 }, (_, i) => i * 1.000123);
const page = collection(Array.from({ length: 100 }, (_, i) => ({
  ...AREA, properties: { ...AREA.properties, IDENTIFIER: "FI " + i, PAD: pad }
})));
const server = http.createServer((req, res) => {
  const q = new URL(req.url || "/", "http://x").searchParams;
  const first = q.get("startIndex") === "0" && (q.get("typeNames") || "").includes("DepthArea");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(first ? page : collection([]));
});
server.listen(0, "127.0.0.1", async () => {
  const job = JSON.parse(jobJson);
  job.download.url = "http://127.0.0.1:" + server.address().port + "/wfs";
  let last = performance.now();
  let longest = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - 5);
    last = now;
  }, 5);
  try {
    const { index, features } = await workerRefresher(job, new AbortController().signal);
    const cells = index.catalogue.cells.map((c) => c.name);
    console.log(JSON.stringify({ longest, bytes: page.length, depthAreas: features.depthAreas, cells }));
  } finally {
    clearInterval(ticker);
    server.close();
  }
});
`;

describe("workerRefresher (compiled lib/)", () => {
  if (!fs.existsSync(LIB_SERVICE) || !fs.existsSync(LIB_WORKER)) {
    throw new Error("lib/ is not built: run `npm run build` before the tests");
  }

  test("a 30 MB page is fetched, parsed and indexed without blocking the main thread", async () => {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ["-e", PAUSE_PROBE, LIB_SERVICE, JSON.stringify(AREA), JSON.stringify(job(""))],
        { encoding: "utf8", timeout: 60_000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      )
    );
    const r = JSON.parse(out) as {
      longest: number;
      bytes: number;
      depthAreas: number;
      cells: string[];
    };
    expect(r.bytes).toBeGreaterThan(30e6);
    expect(r.depthAreas).toBe(100);
    expect(r.cells).toEqual(["FI5SYNTH", "FI1WFS01"]);
    // JSON.parse of this page alone takes 130–145 ms on the x86 machine that measured it.
    expect(r.longest).toBeLessThan(100);
  }, 60_000);
});
