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
