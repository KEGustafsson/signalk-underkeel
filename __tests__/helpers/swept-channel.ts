import type { ChartIndex } from "../../src/spatial/chart-index";
import { pluginBuild } from "../../src/spatial/build-items";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { RuleIndex } from "../../src/spatial/rules";
import type { Box } from "./synthetic";
import { area, coverage, quality } from "./synthetic";

/** The chart a swept channel lies in: one 0–3 m depth area over it and its banks. */
export const CHANNEL_AREA: Box = [22.0, 60.0, 22.02, 60.01];
/** The channel's line; the dredged pieces reach 11 m each side of it. */
export const CHANNEL_LAT = 60.005;

/**
 * A channel dredged to 2.7 m, about 22 m wide along 60.005° N, with a 110 m gap at
 * 22.009–22.011° E where only the banks' 0–3 m is charted.
 */
export function gappedChannel(): ChartIndex {
  const features = [
    coverage(CHANNEL_AREA),
    quality(CHANNEL_AREA, 1),
    area(CHANNEL_AREA, 0),
    area([22.0, 60.0049, 22.009, 60.0051], 2.7, { dredged: true }),
    area([22.011, 60.0049, 22.02, 60.0051], 2.7, { dredged: true })
  ];
  return {
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid(features, { minZoom: 12, ...pluginBuild(20) }),
    hazards: new HazardIndex([]),
    rules: new RuleIndex([])
  };
}
