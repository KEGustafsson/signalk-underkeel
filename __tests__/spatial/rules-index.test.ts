import fs from "fs";
import os from "os";
import path from "path";
import { checkRoute } from "../../src/engine/route-check";
import type { LonLat } from "../../src/foundation/geo";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import {
  buildChartIndex,
  loadChartIndex,
  saveChartIndex,
  savedIndexIsCurrent
} from "../../src/spatial/chart-index";
import { CHART_DATUM } from "../helpers/engine";

/**
 * Rule features through the whole index (plan §4.11): read with the cell, built into the
 * index, saved in `rules.json` and loaded back, and an index saved before them is rebuilt.
 */

const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "enc", "FI5SYNTH");
const NOW = Date.parse("2026-10-18T07:00:00Z");

const collection = (features: object[]) => JSON.stringify({ type: "FeatureCollection", features });

describe("rule features in the index", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-rules-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** The synthetic cell with a bridge across its fairway and a prohibited area off it. */
  function cellWithRules(): string {
    const dir = path.join(tmp, "FI5SYNTH");
    fs.cpSync(FIXTURE, dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "BRIDGE.geojson"),
      collection([
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [22.017, 60.005],
              [22.017, 60.015]
            ]
          },
          properties: { VERCLR: 18, LNAM: "FI5-BRIDGE" }
        }
      ])
    );
    fs.writeFileSync(
      path.join(dir, "RESARE.geojson"),
      collection([
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [22.005, 59.995],
                [22.008, 59.995],
                [22.008, 59.998],
                [22.005, 59.998],
                [22.005, 59.995]
              ]
            ]
          },
          properties: { RESTRN: ["7"] }
        }
      ])
    );
    return dir;
  }

  test("read with the cell, saved and loaded back, held to by the route check", () => {
    const cell = readCellDirectory(cellWithRules(), 0);
    expect(cell.rules.map((r) => r.objectClass)).toEqual(["BRIDGE", "RESARE"]);
    const indexDir = path.join(tmp, "index");
    saveChartIndex(indexDir, buildChartIndex([cell], { minZoom: 12, leafZoom: 18 }));
    expect(savedIndexIsCurrent(indexDir)).toBe(true);
    const index = loadChartIndex(indexDir);
    expect(index.rules.features()).toEqual(cell.rules);
    const fairway: LonLat[] = [
      [22.004, 60.01],
      [22.03, 60.01]
    ];
    const r = checkRoute(
      index,
      {
        coordinates: fairway,
        departure: NOW,
        speeds: [2.5],
        xteLimit: 20,
        hullBuffer: 10,
        vessel: { draft: 1.5, length: 12, beam: 4, airHeight: 19 },
        dynamics: DEFAULT_DYNAMICS,
        waterLevel: () => CHART_DATUM,
        highWater: () => CHART_DATUM,
        probability: 0.01
      },
      NOW
    );
    expect(r.legs[0]).toMatchObject({
      status: "fail",
      flags: expect.arrayContaining(["AIR_DRAFT"])
    });
  });

  test("an index saved before rules.json is not current, and is rebuilt", () => {
    const indexDir = path.join(tmp, "index");
    saveChartIndex(
      indexDir,
      buildChartIndex([readCellDirectory(FIXTURE, 0)], { minZoom: 12, leafZoom: 18 })
    );
    fs.rmSync(path.join(indexDir, "rules.json"));
    expect(savedIndexIsCurrent(indexDir)).toBe(false);
    expect(() => loadChartIndex(indexDir)).toThrow();
  });
});
