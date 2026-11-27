import fs from "fs";
import os from "os";
import path from "path";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { StagedTile } from "../../src/ingest/odc";
import {
  coverageParts,
  coverageTiles,
  ODC_CELL_NAME,
  ODC_SOURCE,
  odcCellLayers,
  readStagedTiles,
  tileBbox,
  tilesToRead,
  writeOdcCell,
  writeStagedTile
} from "../../src/ingest/odc";
import type { Bbox } from "../../src/ingest/wfs";
import type { LonLatPoint } from "../helpers/mvt-encode";
import { encodeTile } from "../helpers/mvt-encode";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-odc-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Two z15 tiles side by side off Brittany. */
const A = { z: 15, x: 15920, y: 11414 };
const B = { z: 15, x: 15921, y: 11414 };

function at(id: typeof A, fx: number, fy: number): LonLatPoint {
  const [w, s, e, n] = tileBbox(id);
  return [w + (e - w) * fx, s + (n - s) * fy];
}

const square = (id: typeof A, fw: number, fs: number, fe: number, fn: number): LonLatPoint[] => [
  at(id, fw, fs),
  at(id, fe, fs),
  at(id, fe, fn),
  at(id, fw, fn),
  at(id, fw, fs)
];

/** As tippecanoe writes them: each tile's features run past its edge into the buffer. */
function staged(): StagedTile[] {
  return [A, B].map((id) => ({
    ...id,
    data: encodeTile(id, {
      DEPARE: [{ polygon: [[square(id, -0.1, -0.1, 1.1, 1.1)]], properties: { DRVAL1: 5 } }],
      SOUNDG: [
        { point: [at(id, 0.5, 0.5)], properties: { DEPTH: 7.5 } },
        // In this tile's buffer: the neighbour holds it as its own.
        { point: [at(id, 1.05, 0.5)], properties: { DEPTH: 7.5 } }
      ],
      DEPCNT: [{ line: [[at(id, 0, 0.5), at(id, 1, 0.5)]], properties: { VALDCO: 5 } }]
    })
  }));
}

const bboxOf = (a: Bbox, b: Bbox): Bbox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3])
];

describe("Open Data Charts tiles to read", () => {
  test("coverage entries name z/x/y tiles; anything else is skipped", () => {
    expect(
      coverageTiles([{ tiles: ["9/248/178", "bad", 7] }, null, { tiles: ["10/497/356"] }])
    ).toEqual([
      { z: 9, x: 248, y: 178 },
      { z: 10, x: 497, y: 356 }
    ]);
    expect(coverageTiles(undefined)).toEqual([]);
  });

  test("only tiles meeting the box inside a covered tile are read", () => {
    const box = bboxOf(tileBbox(A), tileBbox(B));
    // Shrunk so the box does not reach the neighbours it touches.
    const inner: Bbox = [box[0] + 1e-6, box[1] + 1e-6, box[2] - 1e-6, box[3] - 1e-6];
    expect(tilesToRead(inner, [{ z: 9, x: 15920 >> 6, y: 11414 >> 6 }])).toEqual([A, B]);
    expect(tilesToRead(inner, [A])).toEqual([A]);
    expect(tilesToRead(inner, [{ z: 9, x: 0, y: 0 }])).toEqual([]);
  });

  test("the staging file gives back the tiles written to it; a torn one throws", () => {
    const file = path.join(TMP, "staged.bin");
    const fd = fs.openSync(file, "w");
    for (const t of staged()) {
      writeStagedTile(fd, t);
    }
    fs.closeSync(fd);
    const back = readStagedTiles(file);
    expect(back.map(({ z, x, y }) => ({ z, x, y }))).toEqual([A, B]);
    expect(Buffer.from(back[1]?.data ?? []).equals(Buffer.from(staged()[1]?.data ?? []))).toBe(
      true
    );
    fs.truncateSync(file, fs.statSync(file).size - 3);
    expect(() => readStagedTiles(file)).toThrow(/truncated tile/);
  });

  test("the coverage is the tiles read, one rectangle per run along a row, cut to the box", () => {
    const box = bboxOf(tileBbox(A), tileBbox(B));
    expect(coverageParts([A, B], box)).toEqual([box]);
    const half: Bbox = [box[0], box[1], (box[0] + box[2]) / 2, box[3]];
    expect(coverageParts([A, B, { ...A, x: A.x + 5 }], half)).toEqual([half]);
  });
});

describe("the Open Data Charts cell", () => {
  const box = bboxOf(tileBbox(A), tileBbox(B));

  test("each feature is read once, from the tile it lies in, and cut to that tile", () => {
    const { layers, counts } = odcCellLayers(staged(), box, new Date(0));
    expect(counts.tiles).toBe(2);
    expect(layers.SOUNDG?.features).toHaveLength(2);
    expect(layers.DEPARE?.features).toHaveLength(2);
    for (const [i, f] of (layers.DEPARE?.features ?? []).entries()) {
      const [w, s, e, n] = tileBbox(i === 0 ? A : B);
      expect(f.geometry?.type).toBe("MultiPolygon");
      const ring = (f.geometry?.coordinates as LonLatPoint[][][])[0]?.[0];
      if (!ring) {
        throw new Error("no exterior ring");
      }
      expect(ring.length).toBeGreaterThanOrEqual(4);
      for (const [lon, lat] of ring) {
        expect(lon).toBeGreaterThanOrEqual(w - 1e-9);
        expect(lon).toBeLessThanOrEqual(e + 1e-9);
        expect(lat).toBeGreaterThanOrEqual(s - 1e-9);
        expect(lat).toBeLessThanOrEqual(n + 1e-9);
      }
    }
    // Contour lines are not read by the index.
    expect(layers.DEPCNT).toBeUndefined();
  });

  test("it is marked as Open Data Charts, covers the tiles read and carries the assumed quality", () => {
    const half: Bbox = [box[0], box[1], (box[0] + box[2]) / 2 - 1e-6, box[3]];
    const { layers, counts } = odcCellLayers(staged(), half, new Date(0), 4);
    expect(counts.tiles).toBe(1);
    expect(layers.DSID?.features[0]?.properties).toMatchObject({
      DSID_DSNM: `${ODC_CELL_NAME}.000`,
      UK_SOURCE: ODC_SOURCE
    });
    expect(layers.M_COVR?.features).toHaveLength(1);
    expect(layers.M_QUAL?.features[0]?.properties).toMatchObject({ CATZOC: 4 });
    expect(odcCellLayers(staged(), half, new Date(0)).layers.M_QUAL?.features).toEqual([]);
  });

  test("a tile that is not a vector tile is left out with no coverage, the rest read, and told", () => {
    const [, good] = staged();
    if (!good) {
      throw new Error("no tile");
    }
    const tiles = [{ ...A, data: Uint8Array.from([0x1a, 0x09]) }, good];
    const { layers, counts } = odcCellLayers(tiles, box, new Date(0));
    expect(counts).toMatchObject({ tiles: 1, skipped: 1 });
    expect(counts.error).toContain(`Open Data Charts tile 15/${A.x}/${A.y}`);
    expect(layers.M_COVR?.features).toHaveLength(1);
    const [w] = tileBbox(B);
    const covr = layers.M_COVR?.features[0]?.geometry?.coordinates as LonLatPoint[][];
    expect(Math.min(...(covr[0] ?? []).map(([lon]) => lon))).toBeCloseTo(w, 9);
    expect(layers.SOUNDG?.features).toHaveLength(1);
  });

  test("the cell written reads as an advisory band-1 cell on no stated datum", () => {
    const tiles = path.join(TMP, "cell.bin");
    const fd = fs.openSync(tiles, "w");
    staged().forEach((t) => writeStagedTile(fd, t));
    fs.closeSync(fd);
    const dir = path.join(TMP, ODC_CELL_NAME);
    expect(writeOdcCell({ tiles, dir, bbox: box, now: new Date(0).toISOString() })).toEqual({
      tiles: 2,
      features: 4,
      skipped: 0
    });
    const cell = readCellDirectory(dir, 0);
    expect(cell.info).toMatchObject({ name: ODC_CELL_NAME, band: 1, source: ODC_SOURCE });
    expect(cell.info.verticalDatum).toBeUndefined();
  });
});
