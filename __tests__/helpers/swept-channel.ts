import { fairwayGaps } from "../../src/ingest/fairway-gaps";
import { FAIRWAY_GAP, parseRuleLayer } from "../../src/ingest/rule-features";
import type { GeoJsonFeatureCollection } from "../../src/ingest/s57-geojson";
import type { WfsFeature } from "../../src/ingest/wfs-fetch";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { pluginBuild } from "../../src/spatial/build-items";
import { HazardIndex } from "../../src/spatial/hazards";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { RuleIndex } from "../../src/spatial/rules";
import type { Box } from "./synthetic";
import { area, coverage, quality, swept } from "./synthetic";

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

/** Half the bridged channel's width, degrees of latitude: 18 m, Lillholmen's 36 m. */
const BRIDGED_HALF = 18 / 111_320;
/** Where the bridged channel's swept areas end and start again: a gap of about 67 m. */
export const BRIDGE_GAP = [22.0094, 22.0106] as const;

const sweptBox = (west: number, east: number): Box => [
  west,
  CHANNEL_LAT - BRIDGED_HALF,
  east,
  CHANNEL_LAT + BRIDGED_HALF
];

/** A swept area as the FTIA's WFS gives it, after `wfs-ftia.ts`. */
function ftiaArea(id: string, [w, s, e, n]: Box): WfsFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s]
        ]
      ]
    },
    properties: { DRVAL1: 2.7, IDENTIFIER: id, vertaustaso: "MW2020" }
  };
}

/**
 * A channel swept to 2.7 m, 36 m wide along 60.005° N, its swept areas off for the gap under a
 * bridge (`BRIDGE_GAP`), where only the banks' 0–3 m is charted, and the fairway's line, kept
 * clear to 2.7 m, through it: the gap's strip along the line (`ingest/fairway-gaps.ts`) is a
 * rule feature, as the WFS cell's `FAIRWAYGAP` layer gives it, and none of the index's tiles.
 */
export function bridgedChannel(): ChartIndex {
  const west = sweptBox(22.0, BRIDGE_GAP[0]);
  const east = sweptBox(BRIDGE_GAP[1], 22.02);
  const line: WfsFeature = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [22.0, CHANNEL_LAT],
        [22.02, CHANNEL_LAT]
      ]
    },
    properties: { haraussyvyys: 2.7, vertaustaso: "MW2020" }
  };
  const gaps = fairwayGaps([line], [ftiaArea("W", west), ftiaArea("E", east)]);
  const layer = {
    type: "FeatureCollection",
    features: gaps.map((g) => ({
      ...g,
      properties: { DRVAL1: g.properties?.DRVAL1, LNAM: g.properties?.IDENTIFIER }
    }))
  } as GeoJsonFeatureCollection;
  const features = [
    coverage(CHANNEL_AREA),
    quality(CHANNEL_AREA, 1),
    area(CHANNEL_AREA, 0),
    ...[west, east].flatMap((b) => [area(b, 2.7, { dredged: true }), swept(b, 2.7)])
  ];
  return {
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid(features, { minZoom: 12, ...pluginBuild(20) }),
    hazards: new HazardIndex([]),
    rules: new RuleIndex(parseRuleLayer(FAIRWAY_GAP, layer, 0))
  };
}
