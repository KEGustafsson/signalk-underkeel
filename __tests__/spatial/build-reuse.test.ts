import fs from "fs";
import os from "os";
import path from "path";
import type { LonLat } from "../../src/foundation/geo";
import type { Bbox, WfsLayers } from "../../src/ingest/wfs";
import { boxAround, toCellLayers, writeCell } from "../../src/ingest/wfs";
import type { BuildJob } from "../../src/spatial/build-worker";
import { runBuild } from "../../src/spatial/build-worker";
import { REACH_FILE } from "../../src/spatial/build-reuse";
import { commitChartIndex, loadChartIndex } from "../../src/spatial/chart-index";
import { rootColumns } from "../../src/spatial/tile-reuse";
import { pyramidColumns } from "../../src/spatial/store";
import { spreadCells } from "../helpers/shifted-cells";

/**
 * A Traficom WFS refresh builds only the z10 roots the old and new boxes
 * reach (IX-7) and copies the others from the saved index. The staged files
 * must be the ones a build of every root writes, byte for byte.
 */

const FILES = ["cells.json", "pyramid.bin", "hazards.bin", REACH_FILE];
/** z10 tile edges near the ENC copies: a column edge in longitude, a row edge in latitude. */
const COLUMN_EDGE = 575 * (360 / 1024) - 180;
const ROW_EDGE = 60.065;

let tmp: string;
let enc: string[];
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-reuse-"));
  enc = spreadCells(path.join(tmp, "enc"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const square = (lon: number, lat: number, dLon: number, dLat: number): number[][][] => [
  [
    [lon, lat],
    [lon + dLon, lat],
    [lon + dLon, lat + dLat],
    [lon, lat + dLat],
    [lon, lat]
  ]
];

/**
 * Depth areas on a grid over the whole test region and soundings along the
 * z10 edges, served as the WFS would for `b`: areas reaching it, soundings
 * inside it.
 */
function wfsLayers(b: Bbox): WfsLayers {
  const [w, s, e, n] = b;
  const depthAreas: WfsLayers["depthAreas"] = [];
  for (let i = 0; i < 48; i++) {
    for (let j = 0; j < 18; j++) {
      const lon = 21.6 + i * 0.04;
      const lat = 59.8 + j * 0.03;
      if (lon + 0.04 >= w && lon <= e && lat + 0.03 >= s && lat <= n) {
        depthAreas.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: square(lon, lat, 0.04, 0.03) },
          properties: { DRVAL1: 2 + ((i * 7 + j * 3) % 11), IDENTIFIER: `A${i}-${j}` }
        });
      }
    }
  }
  const soundings: WfsLayers["soundings"] = [];
  for (let k = 0; k < 60; k++) {
    const at: LonLat[] = [
      [COLUMN_EDGE + (k % 2 ? 1e-4 : -1e-4), 59.85 + k * 0.007],
      [21.7 + k * 0.03, ROW_EDGE + (k % 2 ? 5e-5 : -5e-5)]
    ];
    for (const [lon, lat] of at) {
      if (lon >= w && lon <= e && lat >= s && lat <= n) {
        soundings.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: { DEPTH: 1.5 + (k % 5), IDENTIFIER: `S${k}-${lon}` }
        });
      }
    }
  }
  return { depthAreas, dredgedAreas: [], soundings };
}

function writeWfsCell(dir: string, centre: LonLat, radiusKm: number): void {
  const b = boxAround(centre, radiusKm);
  writeCell(dir, toCellLayers(wfsLayers(b), b, new Date("2026-10-20T07:00:00Z"), 3));
}

interface Scenario {
  dirs: string[];
  wfs: string;
  indexDir: string;
}

/** The ENC copies plus a WFS cell for box `from`, built in full and saved. */
async function saved(name: string, from: LonLat, leafZoom: number): Promise<Scenario> {
  const base = path.join(tmp, name);
  const wfs = path.join(base, "wfs", "FI1WFS01");
  writeWfsCell(wfs, from, 4);
  const dirs = [...enc, wfs];
  const indexDir = path.join(base, "index");
  const first = await runBuild({ dirs, leafZoom, indexDir, threads: 1 });
  commitChartIndex(indexDir, first.staging);
  return { dirs, wfs, indexDir };
}

/** The staged index for the cells as they are now, reusing the saved one or built afresh. */
async function rebuilt(s: Scenario, leafZoom: number, reuse: boolean) {
  const job: BuildJob = {
    dirs: s.dirs,
    leafZoom,
    indexDir: reuse ? s.indexDir : path.join(path.dirname(s.indexDir), "fresh"),
    threads: 1,
    ...(reuse ? { changed: [s.wfs] } : {})
  };
  return runBuild(job);
}

function expectSameFiles(a: string, b: string): void {
  for (const f of FILES) {
    expect([f, fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))]).toEqual([
      f,
      true
    ]);
  }
}

describe("WFS refresh reusing the saved index's roots", () => {
  const moves: [string, LonLat, LonLat, number][] = [
    ["within one root away from the ENC cells", [22.65, 60.15], [22.7, 60.16], 15],
    ["over ENC cells and across a column edge", [22.03, 60.0], [22.12, 60.02], 16],
    ["across a row edge", [22.4, 60.04], [22.41, 60.09], 15],
    ["to a box far from the old one", [22.3, 60.0], [23.0, 60.22], 14],
    ["beyond the ENC cells' roots, widening the range", [22.6, 60.05], [23.45, 60.25], 14],
    ["back inside, narrowing the range", [23.45, 60.25], [22.6, 60.05], 14]
  ];

  test.each(moves)("a box moved %s gives the full build's files", async (name, from, to, zoom) => {
    const s = await saved(name.replace(/\W+/g, "-"), from, zoom);
    writeWfsCell(s.wfs, to, 4);
    const reused = await rebuilt(s, zoom, true);
    const full = await rebuilt(s, zoom, false);
    expect(reused.index.roots.copied).toBeGreaterThan(0);
    expect(reused.index.roots.built).toBeGreaterThan(0);
    expect(reused.index.roots.built + reused.index.roots.copied).toBe(full.index.roots.built);
    expectSameFiles(reused.staging, full.staging);
  });

  test("an ENC cell with a new DSID has its roots rebuilt too", async () => {
    const s = await saved("enc-edition", [22.65, 60.15], 14);
    const far = s.dirs.find((d) => d.endsWith("FI5SH5")) as string;
    const dsid = path.join(far, "DSID.geojson");
    const before = fs.readFileSync(dsid, "utf8");
    const depare = path.join(far, "DEPARE.geojson");
    const depths = fs.readFileSync(depare, "utf8");
    try {
      fs.writeFileSync(dsid, before.replace('"DSID_EDTN":"3"', '"DSID_EDTN":"4"'));
      fs.writeFileSync(depare, depths.replace(/"DRVAL1":\s*\d+(\.\d+)?/, '"DRVAL1":0.4'));
      writeWfsCell(s.wfs, [22.66, 60.15], 4);
      const reused = await rebuilt(s, 14, true);
      const full = await rebuilt(s, 14, false);
      expect(
        loadChartIndex(reused.staging).catalogue.cells.find((c) => c.name === "FI5SH5")
      ).toEqual(expect.objectContaining({ edition: 4 }));
      expect(reused.index.roots.copied).toBeGreaterThan(0);
      expectSameFiles(reused.staging, full.staging);
    } finally {
      fs.writeFileSync(dsid, before);
      fs.writeFileSync(depare, depths);
    }
  });

  test.each([
    ["no reach file", (s: Scenario) => fs.rmSync(path.join(s.indexDir, REACH_FILE))],
    [
      "a catalogue without the WFS cell",
      (s: Scenario) => {
        const file = path.join(s.indexDir, "cells.json");
        const c = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: unknown[] };
        fs.writeFileSync(file, JSON.stringify({ ...c, cells: c.cells.slice(0, -1) }));
      }
    ],
    ["a torn pyramid", (s: Scenario) => fs.truncateSync(path.join(s.indexDir, "pyramid.bin"), 40)]
  ])("with %s the saved index is not reused and every root is built", async (name, spoil) => {
    const s = await saved(`spoilt-${name.replace(/\W+/g, "-")}`, [22.65, 60.15], 14);
    spoil(s);
    writeWfsCell(s.wfs, [22.7, 60.16], 4);
    const reused = await rebuilt(s, 14, true);
    expect(reused.index.roots.copied).toBe(0);
    expectSameFiles(reused.staging, (await rebuilt(s, 14, false)).staging);
  });

  test("a saved index at another leaf zoom is not reused", async () => {
    const s = await saved("other-zoom", [22.65, 60.15], 14);
    expect((await rebuilt(s, 15, true)).index.roots.copied).toBe(0);
  });
});

describe("one root's nodes copied out of a store", () => {
  test("the roots' columns, in root order, are the store's", async () => {
    const s = await saved("extract", [22.65, 60.15], 14);
    const pyramid = loadChartIndex(s.indexDir).pyramid;
    const all = pyramidColumns(pyramid);
    const roots = [...pyramid.entries(10)].map(([x, y]) => rootColumns(pyramid, x, y));
    expect(roots.reduce((n, c) => n + c.z.length, 0)).toBe(all.z.length);
    const [x, y] = [...pyramid.entries(10)][0] as [number, number, number];
    const first = rootColumns(pyramid, x, y);
    const z12 = Array.from(first.key.filter((_, i) => first.z[i] === 12));
    const n = 2 ** 12;
    expect(z12.length).toBeGreaterThan(0);
    for (const key of z12) {
      expect([Math.floor(Math.floor(key / n) / 4), (key % n) >> 2]).toEqual([x, y]);
    }
  });
});
