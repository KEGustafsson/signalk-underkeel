import path from "path";
import { cellSources } from "../../src/index-loader";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import { readCell } from "../../src/ingest/cell-source";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { writeSource } from "../../src/spatial/build-source";
import { buildChartIndex, loadChartIndex, saveChartIndex } from "../../src/spatial/chart-index";
import type { IndexBuilder } from "../../src/wfs-service";

/** The scenario as GeoJSON layer directories, read with the internal reader. */
export const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "enc");
/** The same scenario as S-57 cells (fixtures/s57/generate.js), for `cellsDir`. */
export const CELLS = path.resolve(__dirname, "..", "..", "fixtures", "s57", "synth");

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

/** The cells of `sources`, read in order. */
async function readAll(sources: readonly string[]) {
  const cells = [];
  for (const [i, d] of sources.entries()) {
    cells.push(await readCell(d, i));
  }
  return cells;
}

/** The build worker's job run in-process: ts-jest has no compiled worker file. */
export const inlineBuilder: IndexBuilder = async (job) => {
  const { source } = job;
  saveChartIndex(
    job.indexDir,
    buildChartIndex(await readAll(job.dirs), { leafZoom: job.leafZoom }),
    source === undefined ? undefined : (staging) => writeSource(staging, source)
  );
  return loadChartIndex(job.indexDir);
};

let seeded: ChartIndex | undefined;

/** Builds the index `seedFixtureIndex` saves; call it from beforeAll. */
export async function prepareFixtureIndex(): Promise<void> {
  seeded ??= buildChartIndex(await readAll(cellSources(CELLS)), { leafZoom: 18 });
}

/**
 * Saves the index start() would build from `cellsDir: CELLS` at leafZoom 18
 * into `<dataDir>/index`, so start() loads it instead of building one.
 */
export function seedFixtureIndex(dataDir: string): void {
  if (!seeded) {
    throw new Error("call prepareFixtureIndex() in beforeAll first");
  }
  saveChartIndex(path.join(dataDir, "index"), seeded);
}
