import fs from "fs";
import os from "os";
import path from "path";
import * as reader from "../../src/ingest/cell-reader";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import { cellReach, DEFAULT_BUILD, prepareItems } from "../../src/spatial/build-items";
import type { BuildJob, RegionResult } from "../../src/spatial/build-worker";
import { buildByRegion, regionPool, runRegions } from "../../src/spatial/build-worker";
import { buildChartIndex } from "../../src/spatial/chart-index";
import type { RegionPart } from "../../src/spatial/pyramid-regions";
import {
  cellsReaching,
  cellsRootRange,
  joinRegions,
  regionReach,
  rootRegions
} from "../../src/spatial/pyramid-regions";
import { serializePyramid } from "../../src/spatial/store";
import { spreadCells } from "../helpers/shifted-cells";

/**
 * The region build (IX-10) makes the pyramid a build of all cells at once
 * makes, byte for byte, while reading only the cells that reach each column.
 */

let tmp: string;
let dirs: string[];
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-regions-"));
  dirs = spreadCells(tmp);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const inProcess = (j: Parameters<typeof runRegions>[0]) => Promise.resolve(runRegions(j));

describe("pyramid built region by region", () => {
  test.each([16, 18])("equals the build of all cells at leaf zoom %i", async (leafZoom) => {
    const job: BuildJob = { dirs, leafZoom, indexDir: path.join(tmp, "index"), threads: 1 };
    const whole = buildChartIndex(
      dirs.map((d, i) => readCellDirectory(d, i)),
      { leafZoom }
    );
    const regions = await buildByRegion(job, inProcess);
    expect(serializePyramid(regions.pyramid).equals(serializePyramid(whole.pyramid))).toBe(true);
    expect(regions.catalogue).toEqual(whole.catalogue);
    expect(regions.hazards.features()).toEqual(whole.hazards.features());
  });

  test("a cell reaching several roots is parsed once while the budget holds it", async () => {
    const job: BuildJob = { dirs, leafZoom: 14, indexDir: path.join(tmp, "index"), threads: 1 };
    const parses = async (keepBytes: number) => {
      const spy = jest.spyOn(reader, "readCellDirectory");
      try {
        await buildByRegion(job, inProcess, undefined, { keepBytes });
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    // The survey parses each cell once; with room, the regions parse each once more.
    expect(await parses(2 ** 30)).toBe(2 * dirs.length);
    expect(await parses(0)).toBeGreaterThan(2 * dirs.length);
  });

  test("each root reads only the cells that reach it", () => {
    const opts = { ...DEFAULT_BUILD, leafZoom: 16 };
    const reaches = dirs.map((d, i) => cellReach(readCellDirectory(d, i).features, opts));
    const range = cellsRootRange(reaches, opts.minZoom);
    const regions = range ? rootRegions(range) : [];
    expect(regions.length).toBeGreaterThanOrEqual(4);
    const counts = regions.map((r) => cellsReaching(r, opts.minZoom, reaches).length);
    expect(Math.max(...counts)).toBeLessThan(dirs.length);
    // A cell straddling a root's edge is read for both roots.
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(dirs.length);
    // Two rows of one column hold cells, so the join interleaves them.
    const filled = regions.filter((_, i) => (counts[i] as number) > 0);
    expect(filled.some((r, i) => filled.some((q, j) => j !== i && q.minX === r.minX))).toBe(true);
  });

  test("each root indexes exactly the features of its cells that reach it", () => {
    const opts = { ...DEFAULT_BUILD, leafZoom: 16 };
    const cells = dirs.map((d, i) => readCellDirectory(d, i).features);
    const reaches = cells.map((f) => cellReach(f, opts));
    const range = cellsRootRange(reaches, opts.minZoom);
    let dropped = 0;
    for (const region of range ? rootRegions(range) : []) {
      const features = cellsReaching(region, opts.minZoom, reaches).flatMap((i) => cells[i] ?? []);
      const keep = regionReach(region, opts.minZoom);
      const all = prepareItems(features, opts);
      const kept = prepareItems(features, opts, keep);
      // Skipping a point's zone test by its cell's widest radius drops nothing that reaches.
      const reaching = all.filter((it) => keep(it.bbox, it.radius));
      const key = (it: (typeof all)[number]) => [it.f.cellRef, it.f.role, it.bbox, it.radius];
      expect(kept.map(key)).toEqual(reaching.map(key));
      dropped += all.length - kept.length;
    }
    expect(dropped).toBeGreaterThan(0);
  });
});

describe("joining region parts", () => {
  test("parts out of column and row order are refused rather than misjoined", async () => {
    const job: BuildJob = { dirs, leafZoom: 14, indexDir: path.join(tmp, "index"), threads: 1 };
    const parts: RegionPart[] = [];
    await buildByRegion(job, async (j) => {
      const results = runRegions(j);
      j.regions.forEach(({ region }, k) =>
        parts.push({ region, cols: (results[k] as RegionResult).cols })
      );
      return results;
    });
    expect(() => joinRegions(10, 14, [...parts].reverse())).toThrow(/column and row order/);
    const wide = { ...(parts[0] as RegionPart), region: { minX: 0, minY: 0, maxX: 1, maxY: 0 } };
    expect(() => joinRegions(10, 14, [wide])).toThrow(/single columns/);
  });
});

describe("region thread pool", () => {
  test("threads building a column of roots per job make the pyramid one thread makes", async () => {
    const worker = path.resolve(__dirname, "..", "..", "lib", "spatial", "build-worker.js");
    const job: BuildJob = { dirs, leafZoom: 16, indexDir: path.join(tmp, "index"), threads: 1 };
    const serial = await buildByRegion(job, inProcess);
    const pool = regionPool(2, worker);
    try {
      const sharing = { perColumn: true, keepBytes: 2 ** 20 };
      const pooled = await buildByRegion(job, pool.run, undefined, sharing);
      expect(serializePyramid(pooled.pyramid).equals(serializePyramid(serial.pyramid))).toBe(true);
    } finally {
      pool.close();
    }
  });

  test("a thread that dies fails its region and every later one, instead of waiting", async () => {
    const file = path.join(tmp, "crash.js");
    fs.writeFileSync(file, "throw new Error('region thread died');");
    const pool = regionPool(2, file);
    try {
      const region = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const job = { cells: [], regions: [{ region, cells: [] }], leafZoom: 14, keepBytes: 0 };
      await expect(pool.run(job)).rejects.toThrow("region thread died");
      await expect(pool.run(job)).rejects.toThrow("region thread died");
    } finally {
      pool.close();
    }
  });
});
