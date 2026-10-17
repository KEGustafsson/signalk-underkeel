import path from "path";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { buildChartIndex } from "../../src/spatial/chart-index";

export const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "enc");

let cached: ChartIndex | undefined;

/** The synthetic FI5SYNTH + FI4SYNTH scenario at leaf z18, built once per test file. */
export function fixtureIndex(): ChartIndex {
  cached ??= buildChartIndex(
    [
      readCellDirectory(path.join(FIXTURES, "FI5SYNTH"), 0),
      readCellDirectory(path.join(FIXTURES, "FI4SYNTH"), 1)
    ],
    { minZoom: 12, leafZoom: 18 }
  );
  return cached;
}

/** Fixture landmarks (lon, lat). */
export const ROCK: [number, number] = [22.02, 60.01]; // UWTROC VALSOU 3.5 in the 8 m swept fairway
export const BANK: [number, number] = [22.012, 60.0045]; // CATZOC C bank, shoal sounding 1.8 m
export const FAIRWAY_LAT = 60.01;

/** Metres per degree of longitude at the fixture latitude. */
export const M_PER_DEG_LON = 111320 * Math.cos((60.01 * Math.PI) / 180);
