import fs from "fs";
import os from "os";
import path from "path";
import { readCell, scanCellSources } from "../../src/ingest/cell-source";
import {
  baseEdition,
  encCell,
  encFiles,
  encStamp,
  readEncCell,
  readEncLayers
} from "../../src/ingest/enc-wasm";

/** The synthetic cell fixtures/s57/generate.js writes with GDAL's S-57 writer. */
const CELL = path.resolve(__dirname, "..", "..", "fixtures", "s57", "FI5RAW01.000");

let tmp: string;
beforeEach(() => {
  // Resolved, as encFiles resolves a cell's folder: the system's temp folder can be a link.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-s57-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("S-57 cells read with gdal3.js", () => {
  test("a .000 cell reads its DSID, coverage, quality, depths, land and soundings", async () => {
    const cell = await readEncCell(CELL, 3);
    expect(cell.info).toMatchObject({
      name: "FI5RAW01",
      edition: 1,
      update: 0,
      issueDate: "20261001",
      band: 5,
      compilationScale: 12000,
      positionQuality: true,
      files: encStamp(CELL)
    });
    const by = (cls: string) => cell.features.filter((f) => f.objectClass === cls);
    expect(by("M_COVR").map((f) => f.role)).toEqual(["coverage"]);
    expect(by("M_QUAL")).toMatchObject([{ role: "quality", catzoc: 2 }]);
    const [depare] = by("DEPARE");
    expect(depare).toMatchObject({ role: "depth", depth: 2.5, cellRef: 3 });
    // The land square is a hole in the depth area.
    expect(depare?.geom.type === "polygon" && depare.geom.polygons[0]?.holes).toHaveLength(1);
    // Land is placed by the compilation scale: 1 mm at 1:12 000 as a 95 % bound.
    expect(by("LNDARE")).toMatchObject([{ role: "depth", depth: -Infinity, topoSigma: 6 }]);
    expect(
      by("SOUNDG")
        .map((f) => (f.role === "depth" ? f.depth : NaN))
        .sort()
    ).toEqual([3.4, 7.1]);
  });

  test("the stamp follows the base cell and every update beside it", () => {
    const base = path.join(tmp, "FI5RAW01.000");
    fs.copyFileSync(CELL, base);
    fs.writeFileSync(path.join(tmp, "FI5OTHER.001"), "");
    const before = encStamp(base);
    expect(encFiles(base)).toEqual([base]);
    fs.writeFileSync(path.join(tmp, "FI5RAW01.001"), "update");
    expect(encFiles(base)).toEqual([base, path.join(tmp, "FI5RAW01.001")]);
    expect(encStamp(base)).not.toBe(before);
  });

  // Windows makes a file symlink only from an elevated process or in developer mode.
  (process.platform === "win32" ? test.skip : test)(
    "a linked .000 is stamped with the updates beside its target, where GDAL reads them",
    () => {
      const real = path.join(tmp, "ENC_ROOT", "FI5RAW01");
      const cells = path.join(tmp, "cells");
      fs.mkdirSync(real, { recursive: true });
      fs.mkdirSync(cells);
      fs.copyFileSync(CELL, path.join(real, "FI5RAW01.000"));
      const link = path.join(cells, "FI5RAW01.000");
      fs.symlinkSync(path.join(real, "FI5RAW01.000"), link);
      // An update beside the link is not read, so it is not stamped.
      fs.writeFileSync(path.join(cells, "FI5RAW01.001"), "update");
      const before = encStamp(link);
      expect(encFiles(link)).toEqual([link]);
      fs.writeFileSync(path.join(real, "FI5RAW01.001"), "update");
      expect(encFiles(link)).toEqual([link, path.join(real, "FI5RAW01.001")]);
      expect(encStamp(link)).not.toBe(before);
    }
  );

  test("a .000 linked under another name is stamped with the updates named after its target", () => {
    const real = path.join(tmp, "ENC_ROOT", "FI5RAW01");
    const cells = path.join(tmp, "cells");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(cells);
    const target = path.join(real, "FI5RAW01.000");
    fs.copyFileSync(CELL, target);
    // A copy stands in for the link and a spy resolves it, since Windows makes a file
    // symlink only from an elevated process or in developer mode.
    const link = path.join(cells, "harbour.000");
    fs.copyFileSync(CELL, link);
    const realpath = fs.realpathSync;
    const resolve = (p: fs.PathLike): string => (p === link ? target : realpath(p));
    const spy = jest
      .spyOn(fs, "realpathSync")
      .mockImplementation(resolve as unknown as typeof fs.realpathSync);
    try {
      // GDAL opens the target and applies the updates named after it, not after the link.
      fs.writeFileSync(path.join(real, "harbour.001"), "update");
      const before = encStamp(link);
      expect(encFiles(link)).toEqual([link]);
      fs.writeFileSync(path.join(real, "FI5RAW01.001"), "update");
      expect(encFiles(link)).toEqual([link, path.join(real, "FI5RAW01.001")]);
      expect(encStamp(link)).not.toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  test("the stamp recorded is the one taken before the read, not after", async () => {
    const base = path.join(tmp, "FI5RAW01.000");
    fs.copyFileSync(CELL, base);
    const before = encStamp(base);
    const layers = await readEncLayers(base);
    // An update installed while the build works on the read layers is not in them.
    fs.writeFileSync(path.join(tmp, "FI5RAW01.001"), "update");
    expect(encStamp(base)).not.toBe(before);
    expect(encCell(base, layers, 0).info.files).toBe(before);
  });

  test("cells are found in an exchange set's folders and read from the original files", async () => {
    const enc = path.join(tmp, "ENC_ROOT", "FI5RAW01");
    fs.mkdirSync(enc, { recursive: true });
    fs.copyFileSync(CELL, path.join(enc, "FI5RAW01.000"));
    fs.writeFileSync(path.join(tmp, "ENC_ROOT", "CATALOG.031"), "");
    const scan = scanCellSources(tmp);
    expect(scan).toEqual({ sources: [path.join(enc, "FI5RAW01.000")], skipped: [] });
    const cell = await readCell(scan.sources[0] as string, 0);
    expect(cell.info.name).toBe("FI5RAW01");
    // Nothing is written beside the cell.
    expect(fs.readdirSync(enc)).toEqual(["FI5RAW01.000"]);
  });

  test("cells nested below a CATALOG.031 are found from above the exchange set", () => {
    // Rijkswaterstaat's Inland ENC download: <set>/ENC_ROOT/1R/7/<cell>/<cell>.000.
    const root = path.join(tmp, "20261023_U7Inland_Waddenzee_week 43_NL", "ENC_ROOT");
    const cell = path.join(root, "1R", "7", "1R7RAW01");
    fs.mkdirSync(cell, { recursive: true });
    fs.copyFileSync(CELL, path.join(cell, "1R7RAW01.000"));
    expect(scanCellSources(tmp).sources).toEqual([]);
    fs.writeFileSync(path.join(root, "CATALOG.031"), "");
    expect(scanCellSources(tmp).sources).toEqual([path.join(cell, "1R7RAW01.000")]);
    expect(scanCellSources(root).sources).toEqual([path.join(cell, "1R7RAW01.000")]);
  });

  test("a cell up to six folders below a CATALOG.031 is found, not seven", () => {
    const root = path.join(tmp, "ENC_ROOT");
    const six = path.join(root, "a", "b", "c", "d", "e", "FI5SIX01");
    const seven = path.join(root, "a", "b", "c", "d", "e", "f", "FI5SEVEN");
    fs.mkdirSync(six, { recursive: true });
    fs.mkdirSync(seven, { recursive: true });
    fs.copyFileSync(CELL, path.join(six, "FI5SIX01.000"));
    fs.copyFileSync(CELL, path.join(seven, "FI5SEVEN.000"));
    fs.writeFileSync(path.join(root, "CATALOG.031"), "");
    expect(scanCellSources(tmp).sources).toEqual([path.join(six, "FI5SIX01.000")]);
  });

  test("a cell is named by its file, as discovery and the saved index's check name it", async () => {
    const renamed = path.join(tmp, "FI5OTHER.000");
    fs.copyFileSync(CELL, renamed);
    expect((await readEncCell(renamed, 0)).info.name).toBe("FI5OTHER");
  });

  test("the edition comes from the base cell's DSID record, which updates leave alone", () => {
    expect(baseEdition(CELL)).toBe(1);
    const bad = path.join(tmp, "FI5BAD01.000");
    fs.writeFileSync(bad, "not a cell");
    expect(baseEdition(bad)).toBeUndefined();
  });

  test("a file that is not S-57 is refused with GDAL's reason", async () => {
    const bad = path.join(tmp, "FI5BAD01.000");
    fs.writeFileSync(bad, "not a cell");
    await expect(readEncCell(bad, 0)).rejects.toThrow(/GDAL cannot read .*FI5BAD01\.000/);
  });
});
