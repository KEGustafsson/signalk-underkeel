import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";
import type { LonLat } from "../../src/foundation/geo";
import { fromMercator, tileKey, tileRect } from "../../src/foundation/geo";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import { cacheOf } from "../../src/spatial/block-cache";
import {
  buildChartIndex,
  loadChartIndex,
  loadChartIndexAsync,
  saveChartIndex
} from "../../src/spatial/chart-index";
import { reachersOf } from "../../src/spatial/chart-position";
import type { NodeStore } from "../../src/spatial/node-store";
import type { BlockLayout } from "../../src/spatial/pyramid-blocks";
import {
  BYTES_PER_NODE,
  columnsOn,
  DEFAULT_LAYOUT,
  headOn
} from "../../src/spatial/pyramid-blocks";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import {
  openPyramid,
  pyramidFromBuffer,
  serializePyramid,
  wholePyramid
} from "../../src/spatial/store";
import { cellsInTile } from "../../src/spatial/tile-walk";
import { uniform } from "../helpers/arbitraries";
import { spreadCells } from "../helpers/shifted-cells";

/**
 * pyramid.bin in blocks (IX-11): a store that reads its blocks as queries
 * reach them, dropping them again over its budget, answers every query as
 * the store held whole does, and a damaged block is refused.
 */

const FINE: BlockLayout = { residentZoom: 15, blockZoom: 13 };

let tmp: string;
let built: NodeStore;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-blocks-"));
  const dirs = spreadCells(tmp);
  built = buildChartIndex(
    dirs.map((d, i) => readCellDirectory(d, i)),
    { leafZoom: 18 }
  ).pyramid;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Member {
  at: number;
  bytes: number;
}

/** The header and the gzip members of a file, as the table lays them out. */
function parts(file: Buffer) {
  const nl = file.indexOf(0x0a);
  const header = JSON.parse(file.subarray(0, nl).toString("utf8")) as {
    residentZoom: number;
    blockZoom: number;
    resident: number;
    blocks: number;
    head: number;
    count: number;
  };
  const head = headOn(
    gunzipSync(file.subarray(nl + 1, nl + 1 + header.head)),
    header.blocks,
    header.resident
  );
  let at = nl + 1 + header.head;
  const blocks: (Member & { key: number; nodes: number })[] = [];
  for (let b = 0; b < header.blocks; b++) {
    const [key, nodes, bytes] = [...head.table.subarray(3 * b, 3 * b + 3)] as number[];
    blocks.push({ key: key as number, nodes: nodes as number, at, bytes: bytes as number });
    at += bytes as number;
  }
  return { header, head, blocks, end: at };
}

const ordered = (z: Uint8Array, key: Float64Array): boolean =>
  z.every(
    (zoom, i) =>
      i === 0 || zoom > (z[i - 1] as number) || (zoom === z[i - 1] && key[i]! > key[i - 1]!)
  );

describe("pyramid.bin in blocks", () => {
  test("the head holds the coarse zooms, each block one tile's finer nodes, in zoom and key order", () => {
    const file = serializePyramid(built);
    const { header, head, blocks, end } = parts(file);
    expect(end).toBe(file.length);
    expect(header).toMatchObject(DEFAULT_LAYOUT);
    expect(header.blocks).toBeGreaterThan(4);
    expect([...head.cols.z].every((z) => z <= header.residentZoom)).toBe(true);
    expect(ordered(head.cols.z, head.cols.key)).toBe(true);
    expect(blocks.map((b) => b.key)).toEqual(blocks.map((b) => b.key).sort((a, b) => a - b));
    let nodes = header.resident;
    for (const b of blocks) {
      const body = gunzipSync(file.subarray(b.at, b.at + b.bytes));
      expect(body.length).toBe(BYTES_PER_NODE * b.nodes);
      const cols = columnsOn(body, b.nodes);
      expect(ordered(cols.z, cols.key)).toBe(true);
      cols.z.forEach((z, i) => {
        expect(z).toBeGreaterThan(header.residentZoom);
        const n = 2 ** z;
        const x = Math.floor(cols.key[i]! / n);
        const s = 2 ** (z - header.blockZoom);
        expect(
          tileKey(header.blockZoom, Math.floor(x / s), Math.floor((cols.key[i]! % n) / s))
        ).toBe(b.key);
      });
      nodes += b.nodes;
    }
    expect(nodes).toBe(header.count);
    expect(header.count).toBe(built.count);
  });

  test("a flipped byte in any block is refused at load, and the block only when reached", async () => {
    const dir = path.join(tmp, "torn");
    saveChartIndex(dir, { ...buildChartIndex([]), pyramid: built });
    const file = path.join(dir, "pyramid.bin");
    const good = fs.readFileSync(file);
    const { blocks } = parts(good);
    const torn = blocks[Math.floor(blocks.length / 2)] as (typeof blocks)[number];
    const bad = Buffer.from(good);
    bad[torn.at + Math.floor(torn.bytes / 2)] =
      (bad[torn.at + Math.floor(torn.bytes / 2)] as number) ^ 0xff;
    fs.writeFileSync(file, bad);
    expect(() => loadChartIndex(dir)).toThrow(/corrupt/);
    await expect(loadChartIndexAsync(dir)).rejects.toThrow(/corrupt/);
    const store = openPyramid(file);
    const cache = cacheOf(store);
    // A query inside the torn block reads its stand-in, never a node from the damaged bytes.
    const whole = footprintGeom(ringOf(torn.key, DEFAULT_LAYOUT.blockZoom));
    const result = minDepthOver(store, whole);
    expect(cache?.failed.get(torn.key)).toMatch(/corrupt/);
    expect(result.flags & 2).toBe(2);
    expect(result.dMin).toBeLessThanOrEqual(minDepthOver(built, whole).dMin);
  });

  test("a file a byte short or a byte long is refused", () => {
    const file = serializePyramid(built);
    expect(() => pyramidFromBuffer(file.subarray(0, file.length - 1))).toThrow(/truncated/);
    expect(() => pyramidFromBuffer(Buffer.concat([file, Buffer.from([0])]))).toThrow(/corrupt/);
  });
});

function xyOf(key: number, z: number): [number, number] {
  const n = 2 ** z;
  return [Math.floor(key / n), key % n];
}

/** Block tile `key`'s rectangle, inset 1 m so it meets no neighbour. */
function insetOf(key: number, z: number) {
  const r = tileRect(z, ...xyOf(key, z));
  return { minX: r.minX + 1, minY: r.minY + 1, maxX: r.maxX - 1, maxY: r.maxY - 1 };
}

function ringOf(key: number, z: number): LonLat[] {
  const r = insetOf(key, z);
  return [
    fromMercator(r.minX, r.minY),
    fromMercator(r.maxX, r.minY),
    fromMercator(r.maxX, r.maxY),
    fromMercator(r.minX, r.maxY)
  ];
}

/** A box of half-size `r` metres around a point of root `k` of the store. */
function queryArb(store: NodeStore) {
  const roots = [...store.entries(store.minZoom)].map(([x, y]) => tileRect(store.minZoom, x, y));
  return fc
    .record({
      root: fc.integer({ min: 0, max: roots.length - 1 }),
      u: uniform(0, 1),
      v: uniform(0, 1),
      half: uniform(0, 3000),
      buffer: fc.constantFrom(0, 20, 300),
      k: fc.constantFrom(0, 2),
      risk: fc.option(fc.record({ threshold: uniform(0, 8), sigmaExtra: uniform(0, 0.5) })),
      stop: fc.boolean()
    })
    .map((q) => {
      const r = roots[q.root] as ReturnType<typeof tileRect>;
      const c = fromMercator(r.minX + q.u * (r.maxX - r.minX), r.minY + q.v * (r.maxY - r.minY));
      const d = q.half / 111_000;
      const ring: LonLat[] =
        q.half === 0
          ? [c]
          : [
              [c[0] - 2 * d, c[1] - d],
              [c[0] + 2 * d, c[1] - d],
              [c[0] + 2 * d, c[1] + d],
              [c[0] - 2 * d, c[1] + d]
            ];
      const opts = {
        bufferMetres: q.buffer,
        chartReachK: q.k,
        ...(q.risk ? { risk: q.risk, stopWhenCertain: q.stop } : {})
      };
      return { ring, opts, centre: c };
    });
}

describe.each([
  ["default", DEFAULT_LAYOUT],
  ["fine", FINE]
])("a store read block by block (%s layout) answers as the store held whole", (_, layout) => {
  test("minDepthOver, with blocks dropped between queries", () => {
    const file = serializePyramid(built, layout);
    const { blocks } = parts(file);
    // A third of the blocks' columns, so a sweep of them all must drop some.
    const budgetBytes = (BYTES_PER_NODE * blocks.reduce((n, b) => n + b.nodes, 0)) / 3;
    const lazy = pyramidFromBuffer(file, { budgetBytes, syncBytes: Infinity });
    const cache = cacheOf(lazy);
    expect(cache?.size).toBeGreaterThan(4);
    fc.assert(
      fc.property(queryArb(built), ({ ring, opts }) => {
        cache?.trim();
        const geom = footprintGeom(ring);
        expect(minDepthOver(lazy, geom, opts)).toEqual(minDepthOver(built, geom, opts));
      }),
      { numRuns: 300 }
    );
    // Every block twice over, so some are dropped and read again whatever the queries reached.
    for (const b of [...blocks, ...blocks]) {
      cache?.trim();
      const geom = footprintGeom(ringOf(b.key, layout.blockZoom));
      expect(minDepthOver(lazy, geom)).toEqual(minDepthOver(built, geom));
    }
    expect(cache?.loads).toBeGreaterThan(cache?.count ?? 0);
  });

  test("cells in a map tile and the cells reaching it", () => {
    const lazy = pyramidFromBuffer(serializePyramid(built, layout), {
      budgetBytes: 200_000,
      syncBytes: Infinity
    });
    fc.assert(
      fc.property(queryArb(built), fc.integer({ min: 10, max: 19 }), ({ centre }, z) => {
        cacheOf(lazy)?.trim();
        const n = 2 ** z;
        const x = Math.floor(((centre[0] + 180) / 360) * n);
        const lat = (centre[1] * Math.PI) / 180;
        const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
        expect(cellsInTile(lazy, z, x, y, z + 6)).toEqual(cellsInTile(built, z, x, y, z + 6));
        const rect = tileRect(z, x, y);
        expect(reachersOf(lazy, rect, 2, z + 6)).toEqual(reachersOf(built, rect, 2, z + 6));
      }),
      { numRuns: 200 }
    );
  });
});

describe("a store held whole", () => {
  test.each([
    ["default", DEFAULT_LAYOUT],
    ["fine", FINE]
  ])("joined from its blocks (%s layout) is the built store, node for node", (_, layout) => {
    const whole = wholePyramid(pyramidFromBuffer(serializePyramid(built, layout)));
    expect(cacheOf(whole)).toBeUndefined();
    for (let z = built.minZoom; z <= built.leafZoom; z++) {
      const at = (s: NodeStore) =>
        [...s.entries(z)].map(([x, y, i]) => [x, y, s.values(i), s.isSplit(i), s.surveySigma(i)]);
      expect(at(whole)).toEqual(at(built));
    }
    expect(serializePyramid(whole).equals(serializePyramid(built))).toBe(true);
  });

  test("loadChartIndex reads every block into it when asked", () => {
    const dir = path.join(tmp, "whole");
    saveChartIndex(dir, { ...buildChartIndex([]), pyramid: built });
    const { pyramid } = loadChartIndex(dir, { whole: true });
    expect(cacheOf(pyramid)).toBeUndefined();
    expect(pyramid.count).toBe(built.count);
    expect(cacheOf(loadChartIndex(dir).pyramid)).toBeDefined();
  });
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("the block cache", () => {
  const file = () => serializePyramid(built, FINE);

  test("over its budget it drops the least recently used blocks after the turn, never those kept", async () => {
    const store = pyramidFromBuffer(file(), { budgetBytes: 1, syncBytes: Infinity });
    const cache = cacheOf(store);
    if (!cache) {
      throw new Error("no cache");
    }
    const [a, b, c] = cache.keys();
    const rectOf = (key: number) => insetOf(key, FINE.blockZoom);
    await cache.keep([rectOf(a as number)]);
    cache.loadNow(b as number);
    cache.loadNow(c as number);
    expect(cache.count).toBe(3);
    await turn();
    expect(cache.count).toBe(1);
    // The kept block answers without a read.
    const loads = cache.loads;
    const centre = rectOf(a as number);
    minDepthOver(store, footprintGeom([fromMercator(centre.minX + 1, centre.minY + 1)]));
    expect(cache.loads).toBe(loads);
  });

  test("a node index from a dropped block reads as no data, never as another block's node", () => {
    const store = pyramidFromBuffer(file(), { budgetBytes: 1, syncBytes: Infinity });
    const cache = cacheOf(store);
    const [a, b] = cache?.keys() ?? [];
    const [x, y] = xyOf(a as number, FINE.blockZoom);
    const z = FINE.residentZoom + 1;
    const s = 2 ** (z - FINE.blockZoom);
    let i = -1;
    for (let dx = 0; dx < s && i < 0; dx++) {
      for (let dy = 0; dy < s && i < 0; dy++) {
        i = store.find(z, x * s + dx, y * s + dy);
      }
    }
    expect(i).toBeGreaterThanOrEqual(0);
    cache?.trim();
    cache?.loadNow(b as number);
    expect(store.values(i)).toEqual(expect.objectContaining({ dMin: -Infinity, flags: 34 }));
    expect(store.isSplit(i)).toBe(false);
  });

  test("a block above syncBytes is read off the event loop; meanwhile its subtree reads as stand-ins", async () => {
    const store = pyramidFromBuffer(file(), { budgetBytes: Infinity, syncBytes: -1 });
    const cache = cacheOf(store);
    const key = cache?.keys()[0] as number;
    const geom = footprintGeom(ringOf(key, FINE.blockZoom));
    const cold = minDepthOver(store, geom);
    expect(cache?.count).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cache?.count).toBe(1);
    expect(minDepthOver(store, geom)).toEqual(minDepthOver(built, geom));
    expect(cold.flags & 2).toBe(2);
    expect(cold.dMin).toBeLessThanOrEqual(minDepthOver(built, geom).dMin);
  });

  test("loading and dropping a block bumps the load revision and names that block", async () => {
    const store = pyramidFromBuffer(file(), { budgetBytes: 1, syncBytes: Infinity });
    const cache = cacheOf(store);
    const [a, b] = cache?.keys() ?? [];
    const was = store.loadRevision;
    cache?.loadNow(a as number);
    const loaded = store.loadRevision;
    expect(loaded).toBeGreaterThan(was);
    const [x, y] = xyOf(a as number, FINE.blockZoom);
    expect(store.blocksChangedSince(was)).toEqual([{ z: FINE.blockZoom, x, y }]);
    cache?.loadNow(b as number);
    await turn();
    expect(store.loadRevision).toBeGreaterThan(loaded);
    const keys = store.blocksChangedSince(loaded).map((t) => tileKey(t.z, t.x, t.y));
    expect(keys.sort((p, q) => p - q)).toEqual(
      [a, b].sort((p, q) => (p as number) - (q as number))
    );
    expect(built.loadRevision).toBe(0);
    expect(built.blocksChangedSince(0)).toEqual([]);
  });

  test("blocks are not read from a file replaced since the store was opened", () => {
    const dir = path.join(tmp, "replaced");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "pyramid.bin");
    fs.writeFileSync(target, file());
    const store = openPyramid(target);
    fs.writeFileSync(`${target}.new`, serializePyramid(built));
    fs.renameSync(`${target}.new`, target);
    const key = cacheOf(store)?.keys()[0] as number;
    minDepthOver(store, footprintGeom(ringOf(key, FINE.blockZoom)));
    expect(cacheOf(store)?.failed.get(key)).toMatch(/replaced/);
  });
});
