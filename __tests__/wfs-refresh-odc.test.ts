import fs from "fs";
import os from "os";
import path from "path";
import type { Bbox } from "../src/ingest/wfs";
import type { BoxJobDeps } from "../src/wfs-worker";
import { refreshJob, writeOdc } from "../src/wfs-worker";

/** The Open Data Charts cell in a refresh's build: rebuilt past a box, dropped when unwritable. */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-refresh-odc-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
afterEach(() => jest.restoreAllMocks());

const BBOX: Bbox = [174, -23, 175, -22];
const WFS_DIR = path.join(TMP, "FI1WFS01");
const ODC_DIR = path.join(TMP, "OD1ODC01");

function deps(inBox: boolean, wfs: boolean): BoxJobDeps {
  return {
    config: wfs
      ? ({ url: "https://wfs.example/ows", radiusKm: 10, catzoc: 4 } as never)
      : { radiusKm: 10 },
    inBox,
    index: () => undefined,
    leafZoom: 18,
    indexDir: path.join(TMP, "index")
  };
}

const odc = (tiles = path.join(TMP, "missing.bin")) => ({
  tiles,
  dir: ODC_DIR,
  bbox: BBOX,
  now: new Date(0).toISOString()
});

describe("a whole-index refresh", () => {
  test.each([
    ["beside the WFS", true, [WFS_DIR, ODC_DIR]],
    ["alone", false, [ODC_DIR]]
  ])("marks the Open Data Charts cell changed %s", (_name, wfs, dirs) => {
    const job = refreshJob(deps(false, wfs), WFS_DIR, BBOX, 0, undefined, odc());
    expect(job.build.dirs).toEqual(dirs);
    expect(job.build.changed).toEqual(dirs);
  });

  test("in a box marks nothing changed", () => {
    expect(refreshJob(deps(true, true), WFS_DIR, BBOX, 0, undefined, odc()).build.changed).toBe(
      undefined
    );
  });
});

describe("an Open Data Charts cell that cannot be written", () => {
  test("is left out of the build even when its directory cannot be removed", () => {
    const job = refreshJob(deps(false, true), WFS_DIR, BBOX, 0, undefined, odc());
    jest.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const written = writeOdc(job);
    expect(written.job.build.dirs).toEqual([WFS_DIR]);
    expect(written.odc?.error).toBeDefined();
  });
});
