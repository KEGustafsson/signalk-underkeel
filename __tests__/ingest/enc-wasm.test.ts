import fs from "fs";
import os from "os";
import path from "path";
import { readCell, scanCellSources } from "../../src/ingest/cell-source";
import { baseEdition, encFiles, encStamp, readEncCell } from "../../src/ingest/enc-wasm";

/** The synthetic cell fixtures/s57/generate.js writes with GDAL's S-57 writer. */
const CELL = path.resolve(__dirname, "..", "..", "fixtures", "s57", "FI5RAW01.000");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-s57-"));
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
