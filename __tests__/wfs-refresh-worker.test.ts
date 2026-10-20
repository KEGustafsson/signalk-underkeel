import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { boxAround } from "../src/ingest/wfs";
import { commitChartIndex, loadChartIndex } from "../src/spatial/chart-index";
import type { WfsRefresher } from "../src/wfs-service";
import type { WfsJob, WfsReply } from "../src/wfs-worker";
import { FIXTURES } from "./helpers/fixture-index";

/**
 * The Traficom WFS refresh worker (PL4): download, parse, clip, cell write and index build
 * all off the main thread. The entry runs in-process with a stubbed worker_threads; the real
 * thread needs the compiled lib/, which `npm run build` makes. The WFS is a local HTTP server.
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

describe("WFS refresh worker entry", () => {
  test("downloads the box, writes the cell and stages an index for the main thread", async () => {
    const wfs = await wfsServer(collection([AREA]));
    try {
      const j = job(wfs.url);
      const messages: WfsReply[] = [];
      jest.isolateModules(() => {
        jest.doMock("worker_threads", () => ({
          parentPort: { postMessage: (m: WfsReply) => messages.push(m) },
          workerData: j
        }));
        require("../src/wfs-worker");
      });
      jest.dontMock("worker_threads");
      for (let i = 0; i < 100 && messages.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(messages).toEqual([
        {
          ok: true,
          staging: expect.any(String),
          features: { depthAreas: 1, dredgedAreas: 0, soundings: 0 }
        }
      ]);
      expect(fs.existsSync(j.build.indexDir)).toBe(false);
      commitChartIndex(j.build.indexDir, messages[0]?.staging as string);
      expect(loadChartIndex(j.build.indexDir).catalogue.cells.map((c) => c.name)).toEqual([
        "FI5SYNTH",
        "FI1WFS01"
      ]);
    } finally {
      wfs.close();
    }
  });
});

describe("workerRefresher (compiled lib/)", () => {
  if (!fs.existsSync(LIB_SERVICE) || !fs.existsSync(LIB_WORKER)) {
    throw new Error("lib/ is not built: run `npm run build` before the tests");
  }

  test("a 30 MB page is fetched, parsed and indexed without blocking the main thread", async () => {
    // Bulky attributes the cell does not keep: the page is large, the index small.
    const pad = Array.from({ length: 20_000 }, (_, i) => i * 1.000123);
    const page = collection(
      Array.from({ length: 100 }, (_, i) => ({
        ...AREA,
        properties: { ...AREA.properties, IDENTIFIER: `FI ${i}`, PAD: pad }
      }))
    );
    expect(page.length).toBeGreaterThan(30e6);
    const wfs = await wfsServer(page);
    const { workerRefresher } = (await import(LIB_SERVICE)) as {
      workerRefresher: WfsRefresher;
    };
    let last = performance.now();
    let longest = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last - 5);
      last = now;
    }, 5);
    try {
      const { index, features } = await workerRefresher(job(wfs.url), new AbortController().signal);
      expect(features.depthAreas).toBe(100);
      expect(index.catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH", "FI1WFS01"]);
    } finally {
      clearInterval(ticker);
      wfs.close();
    }
    // JSON.parse of this page alone takes 130–145 ms on the x86 machine that measured it.
    expect(longest).toBeLessThan(100);
  }, 60_000);
});
