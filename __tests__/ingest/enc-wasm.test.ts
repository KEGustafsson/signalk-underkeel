import fs from "fs";
import os from "os";
import path from "path";
import { cellVersionRank, readCell, scanCellSources } from "../../src/ingest/cell-source";
import { withDsidVersion } from "../helpers/dsid";
import {
  baseEdition,
  baseVersion,
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

  test("a folder reached first by a shallow link is read again from its exchange set", () => {
    const root = path.join(tmp, "set", "ENC_ROOT");
    const cell = path.join(root, "1R", "7", "WAD", "1R6DEEP1");
    fs.mkdirSync(cell, { recursive: true });
    fs.copyFileSync(CELL, path.join(cell, "1R6DEEP1.000"));
    fs.writeFileSync(path.join(root, "CATALOG.031"), "");
    // Sorted first, the link reaches 1R with too little depth left to find the cell, four
    // folders below it; the exchange set's CATALOG.031 leaves enough.
    fs.symlinkSync(path.join(root, "1R"), path.join(tmp, "a-link"), "junction");
    fs.mkdirSync(path.join(root, "1R", "7", "1R6NONE1"));
    expect(scanCellSources(tmp)).toEqual({
      sources: [path.join(cell, "1R6DEEP1.000")],
      skipped: [
        path.join("a-link", "7", "1R6NONE1"),
        path.join("set", "ENC_ROOT", "1R", "7", "1R6NONE1")
      ]
    });
  });

  test("a cell folder holding a link to a cell kept elsewhere is not reported as skipped", () => {
    const store = path.join(tmp, "store");
    const cells = path.join(tmp, "cells");
    const folder = path.join(cells, "FI5LINK1");
    fs.mkdirSync(store);
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(store, "FI5LINK1.000");
    fs.copyFileSync(CELL, target);
    // A copy and a spy stand in for the file link, as Windows makes one only when elevated.
    const link = path.join(folder, "FI5LINK1.000");
    fs.copyFileSync(CELL, link);
    const realpath = fs.realpathSync;
    const resolve = (p: fs.PathLike): string => (p === link ? target : realpath(p));
    const spy = jest
      .spyOn(fs, "realpathSync")
      .mockImplementation(resolve as unknown as typeof fs.realpathSync);
    try {
      expect(scanCellSources(cells)).toEqual({ sources: [link], skipped: [] });
    } finally {
      spy.mockRestore();
    }
  });

  test("a link looping back into an exchange set ends the scan there", () => {
    const root = path.join(tmp, "ENC_ROOT");
    const cell = path.join(root, "FI5LOOP1");
    fs.mkdirSync(cell, { recursive: true });
    fs.copyFileSync(CELL, path.join(cell, "FI5LOOP1.000"));
    fs.writeFileSync(path.join(root, "CATALOG.031"), "");
    // A junction on Windows, where a directory symlink needs elevated rights.
    fs.symlinkSync(root, path.join(cell, "back"), "junction");
    expect(scanCellSources(tmp)).toEqual({
      sources: [path.join(cell, "FI5LOOP1.000")],
      skipped: []
    });
  });

  test("a cell is named by its file, as discovery and the saved index's check name it", async () => {
    const renamed = path.join(tmp, "FI5OTHER.000");
    fs.copyFileSync(CELL, renamed);
    expect((await readEncCell(renamed, 0)).info.name).toBe("FI5OTHER");
  });

  test("the edition comes from the base cell's DSID record, which updates leave alone", () => {
    expect(baseEdition(CELL)).toBe(1);
    expect(baseVersion(CELL)).toEqual({ edition: 1, update: 0 });
    // An edition or update too large to be one is not known: it would outrank every copy.
    const huge = path.join(tmp, "FI5HUGE1.000");
    const bytes = fs.readFileSync(CELL);
    const at = bytes.indexOf(Buffer.from([0x1f, 0x31, 0x1f, 0x30, 0x1f]));
    expect(at).toBeGreaterThan(0);
    fs.writeFileSync(
      huge,
      Buffer.concat([
        bytes.subarray(0, at + 1),
        Buffer.from("9".repeat(400)),
        bytes.subarray(at + 2)
      ])
    );
    expect(baseVersion(huge)).toBeUndefined();
    expect(baseEdition(huge)).toBeUndefined();
    // Records laid out as S-57 lays them out: the largest edition and update are known, one
    // past either is not, and an update past its limit leaves the edition known.
    const version = (edition: string, update: string) => {
      const file = path.join(tmp, "FI5VERS1.000");
      fs.writeFileSync(file, withDsidVersion(fs.readFileSync(CELL), edition, update));
      return { version: baseVersion(file), edition: baseEdition(file) };
    };
    expect(version("9999", "999")).toEqual({
      version: { edition: 9999, update: 999 },
      edition: 9999
    });
    expect(version("10000", "0")).toEqual({ version: undefined, edition: undefined });
    // Edition 0, as NOAA update files carry it, is no base cell's edition.
    expect(version("0", "0")).toEqual({ version: undefined, edition: undefined });
    expect(version("1", "1000")).toEqual({ version: undefined, edition: 1 });
    // A directory entry of size 0 is refused, not walked forever.
    const zero = path.join(tmp, "FI5ZERO1.000");
    const cell = Buffer.from(fs.readFileSync(CELL));
    const dr = Number(cell.toString("latin1", 0, 5));
    for (const at of [dr + 20, dr + 21, dr + 23]) {
      cell[at] = 0x30;
    }
    fs.writeFileSync(zero, cell);
    expect(baseVersion(zero)).toBeUndefined();
    expect(baseEdition(zero)).toBeUndefined();
    const bad = path.join(tmp, "FI5BAD01.000");
    fs.writeFileSync(bad, "not a cell");
    expect(baseEdition(bad)).toBeUndefined();
  });

  test("a copy's rank is the update GDAL applies, and -1 where GDAL gives up on the cell", async () => {
    const bytes = fs.readFileSync(CELL);
    const copy = (name: string, updn: string, updates: [number, string, string][]) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      const file = path.join(dir, "FI5SYNTH.000");
      fs.writeFileSync(file, withDsidVersion(bytes, "1", updn));
      for (const [n, edition, update] of updates) {
        const updateFile = file.replace(/000$/, String(n).padStart(3, "0"));
        fs.writeFileSync(updateFile, withDsidVersion(bytes, edition, update));
      }
      return file;
    };
    const applied = async (file: string) => (await readEncCell(file, 0)).info.update;
    const chain = copy("chain", "0", [
      [1, "1", "1"],
      [2, "0", "2"]
    ]);
    expect(await applied(chain)).toBe(2);
    expect(cellVersionRank(chain)).toBe(100_002);
    const reissue = copy("reissue", "3", [[4, "1", "4"]]);
    expect(await applied(reissue)).toBe(3);
    expect(cellVersionRank(reissue)).toBe(100_003);
    const misnamed = copy("misnamed", "0", [
      [1, "1", "1"],
      [2, "1", "5"]
    ]);
    await expect(readEncCell(misnamed, 0)).rejects.toThrow(/GDAL cannot read/);
    expect(cellVersionRank(misnamed)).toBe(-1);
    const unnumbered = copy("unnumbered", "0", [[1, "1", "x"]]);
    await expect(readEncCell(unnumbered, 0)).rejects.toThrow(/GDAL cannot read/);
    expect(cellVersionRank(unnumbered)).toBe(-1);
    // A file beside the cell that is not ISO 8211 ends the updates GDAL applies.
    const ended = copy("ended", "0", [[1, "1", "1"]]);
    fs.writeFileSync(ended.replace(/000$/, "002"), "not S-57");
    expect(await applied(ended)).toBe(1);
    expect(cellVersionRank(ended)).toBe(100_001);
    // So does one whose leader reads but whose header record is cut short.
    const cut = copy("cut", "0", [[1, "1", "1"]]);
    fs.writeFileSync(cut.replace(/000$/, "002"), withDsidVersion(bytes, "1", "2").subarray(0, 40));
    expect(await applied(cut)).toBe(1);
    expect(cellVersionRank(cut)).toBe(100_001);
    // And so does a directory in an update's place: GDAL's Open refuses it.
    const folder = copy("folder", "0", [[1, "1", "1"]]);
    fs.mkdirSync(folder.replace(/000$/, "002"));
    expect(await applied(folder)).toBe(1);
    expect(cellVersionRank(folder)).toBe(100_001);
    // As does an update that cannot be opened, as one without read access cannot.
    const locked = copy("locked", "0", [
      [1, "1", "1"],
      [2, "1", "2"]
    ]);
    const lockedUpdate = locked.replace(/000$/, "002");
    const openSync = fs.openSync;
    const spy = jest.spyOn(fs, "openSync").mockImplementation(((
      p: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (p === lockedUpdate) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return (openSync as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    try {
      expect(cellVersionRank(locked)).toBe(100_001);
    } finally {
      spy.mockRestore();
    }
  });

  test("a file that is not S-57 is refused with GDAL's reason", async () => {
    const bad = path.join(tmp, "FI5BAD01.000");
    fs.writeFileSync(bad, "not a cell");
    await expect(readEncCell(bad, 0)).rejects.toThrow(/GDAL cannot read .*FI5BAD01\.000/);
  });
});
