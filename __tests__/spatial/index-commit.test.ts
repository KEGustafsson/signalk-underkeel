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
    expect(names(target)).toEqual(["cells.json", "hazards.json", "pyramid.bin"]);
    expect(loadChartIndex(target).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
    fs.renameSync(target, path.join(dir, "index.old-1-0-aa"));
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

  test("a moved-aside index stays while the directory is incomplete", () => {
    const target = path.join(dir, "index");
    saveChartIndex(target, synth());
    fs.cpSync(target, path.join(dir, "index.old-7-0-aa"), { recursive: true });
    fs.rmSync(path.join(target, "hazards.json"));
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
