import fs from "fs";
import os from "os";
import path from "path";
import type { GeoJsonFeatureCollection } from "../../src/ingest/s57-geojson";
import { writeCell } from "../../src/ingest/wfs";

const layers = (edition: string): Record<string, GeoJsonFeatureCollection> => ({
  DSID: {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: null, properties: { DSID_EDTN: edition } }]
  },
  SOUNDG: { type: "FeatureCollection", features: [] }
});

const edition = (dir: string): unknown =>
  (JSON.parse(fs.readFileSync(path.join(dir, "DSID.geojson"), "utf8")) as GeoJsonFeatureCollection)
    .features[0]?.properties?.DSID_EDTN;

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-wfs-write-"));
  dir = path.join(tmp, "FI1WFS01");
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the WFS cell is written so a power cut cannot tear it", () => {
  test("every layer and the staging folder are flushed before the swap, the parent after it", () => {
    writeCell(dir, layers("1"));
    const events: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    jest.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      events.push("fsync");
      fsync(fd);
    });
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      events.push(`rename ${path.basename(String(from))} -> ${path.basename(String(to))}`);
      rename(from, to);
    });
    writeCell(dir, layers("2"));
    // The directory flushes are attempted everywhere; where the OS refuses one it is skipped.
    expect(events).toEqual([
      "fsync",
      "fsync",
      "fsync",
      "rename FI1WFS01 -> FI1WFS01.old",
      "rename FI1WFS01.partial -> FI1WFS01",
      "fsync"
    ]);
    expect(edition(dir)).toBe("2");
    expect(fs.readdirSync(tmp)).toEqual(["FI1WFS01"]);
  });

  test("a swap that fails leaves the old cell in place", () => {
    writeCell(dir, layers("1"));
    const rename = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith(".partial")) {
        throw new Error("EIO");
      }
      rename(from, to);
    });
    expect(() => writeCell(dir, layers("2"))).toThrow("EIO");
    expect(edition(dir)).toBe("1");
  });
});
