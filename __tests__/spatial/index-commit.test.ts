import fs from "fs";
import os from "os";
import path from "path";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import {
  buildChartIndex,
  commitChartIndex,
  loadChartIndex,
  recoverChartIndex,
  saveChartIndex,
  stageChartIndex
} from "../../src/spatial/chart-index";

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "enc");
const OPTS = { minZoom: 12, leafZoom: 16 };
const synth = () => buildChartIndex([readCellDirectory(path.join(FIXTURES, "FI5SYNTH"), 0)], OPTS);
const empty = () => buildChartIndex([], OPTS);
const names = (dir: string) => fs.readdirSync(dir).sort();

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-commit-"));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("an indexDir with a trailing separator", () => {
  test("is saved over and recovered like one without it", () => {
    const target = `${path.join(dir, "index")}${path.sep}`;
    saveChartIndex(target, empty());
    saveChartIndex(target, synth());
    expect(names(dir)).toEqual(["index"]);
    expect(names(target)).toEqual(["cells.json", "hazards.bin", "pyramid.bin"]);
    expect(loadChartIndex(target).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
    fs.renameSync(path.join(dir, "index"), path.join(dir, "index.old-1-0-aa"));
    expect(recoverChartIndex(target)).toBe(true);
    expect(names(dir)).toEqual(["index"]);
  });

  test("stages beside the directory, not inside it", () => {
    const staging = stageChartIndex(`${path.join(dir, "index")}${path.sep}`, empty());
    expect(path.dirname(staging)).toBe(dir);
    commitChartIndex(`${path.join(dir, "index")}${path.sep}`, staging);
    expect(names(dir)).toEqual(["index"]);
  });
});

describe("an indexDir holding more than an index", () => {
  test("is refused, not replaced, and nothing is left beside it", () => {
    const charts = path.join(dir, "charts");
    fs.mkdirSync(path.join(charts, "ENC_ROOT"), { recursive: true });
    fs.writeFileSync(path.join(charts, "ENC_ROOT", "US5FL1.000"), "cell");
    fs.writeFileSync(path.join(charts, "cells.json"), "{}");
    expect(() => saveChartIndex(charts, empty())).toThrow(
      /charts holds ENC_ROOT, which is not part of a chart index/
    );
    expect(names(dir)).toEqual(["charts"]);
    expect(names(charts)).toEqual(["ENC_ROOT", "cells.json"]);
    expect(fs.readFileSync(path.join(charts, "ENC_ROOT", "US5FL1.000"), "utf8")).toBe("cell");
  });

  test("a commit refuses one that gained a foreign file after the staging", () => {
    const data = path.join(dir, "data");
    const staging = stageChartIndex(data, empty());
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "acks.json"), "[]");
    expect(() => commitChartIndex(data, staging)).toThrow(/holds acks\.json/);
    expect(names(dir)).toEqual(["data"]);
    expect(names(data)).toEqual(["acks.json"]);
  });

  test("a file in place of the directory is refused", () => {
    fs.writeFileSync(path.join(dir, "index"), "notes");
    expect(() => saveChartIndex(path.join(dir, "index"), empty())).toThrow(/is not a directory/);
    expect(fs.readFileSync(path.join(dir, "index"), "utf8")).toBe("notes");
    expect(names(dir)).toEqual(["index"]);
  });

  test("an empty directory or one with only index files is replaced", () => {
    const target = path.join(dir, "index");
    fs.mkdirSync(target);
    saveChartIndex(target, empty());
    fs.writeFileSync(path.join(target, "reach.json"), "{}");
    fs.writeFileSync(path.join(target, "box.json"), "{}");
    saveChartIndex(target, synth());
    expect(names(target)).toEqual(["cells.json", "hazards.bin", "pyramid.bin"]);
    expect(names(dir)).toEqual(["index"]);
  });
});

describe("a failed save", () => {
  const enospc = () =>
    Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

  test("a write that fails removes its staging", () => {
    const real = fs.writeFileSync;
    jest.spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof real>) => {
      if (Buffer.isBuffer(args[1])) {
        throw enospc();
      }
      real(...args);
    }) as typeof real);
    expect(() => saveChartIndex(path.join(dir, "index"), empty())).toThrow(/ENOSPC/);
    expect(names(dir)).toEqual([]);
  });

  test("a staging rename that fails puts the previous index back and removes the staging", () => {
    const target = path.join(dir, "index");
    saveChartIndex(target, synth());
    const real = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".tmp-")) {
        throw enospc();
      }
      real(from, to);
    });
    expect(() => saveChartIndex(target, empty())).toThrow(/ENOSPC/);
    expect(names(dir)).toEqual(["index"]);
    expect(loadChartIndex(target).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
  });
});

describe("leftovers at recovery", () => {
  test("a moved-aside index is removed once the directory holds a whole index", () => {
    const target = path.join(dir, "index");
    saveChartIndex(target, synth());
    fs.cpSync(target, path.join(dir, "index.old-7-0-aa"), { recursive: true });
    fs.mkdirSync(path.join(dir, "index.old-notes"));
    fs.writeFileSync(path.join(dir, "index.old-notes", "mine.txt"), "keep");
    expect(recoverChartIndex(target)).toBe(false);
    expect(names(dir)).toEqual(["index", "index.old-notes"]);
  });

  test("a user's copy named like a moved-aside index is neither removed nor restored", () => {
    const target = path.join(dir, "index");
    saveChartIndex(target, synth());
    const backup = path.join(dir, "index.old-before-upgrade");
    fs.cpSync(target, backup, { recursive: true });
    expect(recoverChartIndex(target)).toBe(false);
    expect(names(dir)).toEqual(["index", "index.old-before-upgrade"]);
    fs.rmSync(target, { recursive: true });
    expect(recoverChartIndex(target)).toBe(false);
    expect(names(dir)).toEqual(["index.old-before-upgrade"]);
  });

  test("an index moved aside by a version before 2026-10-17 is still restored", () => {
    const target = path.join(dir, "index");
    saveChartIndex(target, synth());
    fs.renameSync(target, path.join(dir, "index.old-12345"));
    expect(recoverChartIndex(target)).toBe(true);
    expect(names(dir)).toEqual(["index"]);
  });

  test("a moved-aside index stays while the directory is incomplete", () => {
    const target = path.join(dir, "index");
    saveChartIndex(target, synth());
    fs.cpSync(target, path.join(dir, "index.old-7-0-aa"), { recursive: true });
    fs.rmSync(path.join(target, "hazards.bin"));
    expect(recoverChartIndex(target)).toBe(false);
    expect(names(dir)).toEqual(["index", "index.old-7-0-aa"]);
  });

  test("the first recovery in a process removes staging under its own id, later ones keep it", () => {
    const target = path.join(dir, "index");
    // What a run with the same process id, as a container restart gives, left behind.
    const previousRun = path.join(dir, `index.tmp-${process.pid}-0-aa`);
    const thisRun = path.join(dir, `index.tmp-${process.pid}-1-bb`);
    jest.isolateModules(() => {
      const fresh = require("../../src/spatial/chart-index") as {
        recoverChartIndex: typeof recoverChartIndex;
      };
      fs.mkdirSync(previousRun);
      expect(fresh.recoverChartIndex(target)).toBe(false);
      expect(fs.existsSync(previousRun)).toBe(false);
      fs.mkdirSync(thisRun);
      expect(fresh.recoverChartIndex(target)).toBe(false);
      expect(fs.existsSync(thisRun)).toBe(true);
    });
  });
});
