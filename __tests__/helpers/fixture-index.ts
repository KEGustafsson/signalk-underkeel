import path from "path";
import { cellSources } from "../../src/index-loader";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { buildChartIndex, loadChartIndex, saveChartIndex } from "../../src/spatial/chart-index";
import type { IndexBuilder } from "../../src/wfs-service";

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
export const BANK: [number, number] = [22.012, 59.9895]; // CATZOC C bank, shoal sounding 1.8 m
export const FAIRWAY_LAT = 60.01;

/** Metres per degree of longitude at the fixture latitude. */
export const M_PER_DEG_LON = 111320 * Math.cos((60.01 * Math.PI) / 180);

/** The build worker's job run in-process: ts-jest has no compiled worker file. */
export const inlineBuilder: IndexBuilder = (job) => {
  saveChartIndex(
    job.indexDir,
    buildChartIndex(
      job.dirs.map((d, i) => readCellDirectory(d, i)),
      { leafZoom: job.leafZoom }
    )
  );
  return Promise.resolve(loadChartIndex(job.indexDir));
};

let seeded: ChartIndex | undefined;

/**
 * Saves the index start() would build from `cellsDir: FIXTURES` at leafZoom 18
 * into `<dataDir>/index`, so start() loads it instead of building one.
 */
export function seedFixtureIndex(dataDir: string): void {
  seeded ??= buildChartIndex(
    cellSources(FIXTURES).map((d, i) => readCellDirectory(d, i)),
    { leafZoom: 18 }
  );
  saveChartIndex(path.join(dataDir, "index"), seeded);
}
