import { parseConfig } from "../src/config";
import type { QueryResult } from "../src/engine/query";
import type { LonLat } from "../src/foundation/geo";
import { offset, tileAt, toMercator } from "../src/foundation/geo";
import type { AreaLevels } from "../src/model/level-regimes";
import type { WaterLevel } from "../src/model/uncertainty";
import { lowerLevel } from "../src/model/water-level";
import type { QueryServiceDeps } from "../src/query-service";
import { query, ukcTileReply } from "../src/query-service";
import { RequestQueue } from "../src/route-service";
import { decodeMvt } from "./helpers/mvt-decode";
import { fixtureIndex, ROCK } from "./helpers/fixture-index";

/**
 * `POST /query` and the UKC tiles take the water level where they are, not
 * where the vessel is (plan §4.5).
 */

const FORECAST: WaterLevel = { h: 0.62, sigma: 0.14, source: "fmi:forecast" };
const FALLBACK: WaterLevel = {
  h: 0,
  sigma: 0.3,
  source: "fallback",
  degraded: "no forecast within 30 km"
};

/** A source that holds `inside` within `metres` of `centre` and falls back beyond, as FMI does. */
function reachAt(centre: LonLat, metres = 30000, inside: WaterLevel = FORECAST): AreaLevels {
  return { inside, beyond: { level: lowerLevel(inside, FALLBACK), reach: { centre, metres } } };
}

function deps(levels: AreaLevels): QueryServiceDeps {
  return {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({ vessel: { draft: 2, length: 12, beam: 4 } }),
    vessel: () => ({ draft: 2, length: 12, beam: 4 }),
    levelRegimes: () => levels,
    waveHeight: () => undefined
  };
}

async function ask(levels: AreaLevels, ring: LonLat[], bufferMetres?: number) {
  const reply = await query(
    {
      geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
      ...(bufferMetres === undefined ? {} : { bufferMetres })
    },
    deps(levels),
    new RequestQueue(),
    new AbortController().signal
  );
  expect(reply.status).toBe(200);
  return reply.body as QueryResult;
}

/** A rectangle around ROCK, `east` and `north` metres from it each way. */
const box = (east: number, north: number): LonLat[] => [
  offset(ROCK, -east, -north),
  offset(ROCK, east, -north),
  offset(ROCK, east, north),
  offset(ROCK, -east, north)
];

describe("POST /query water level", () => {
  const ring = box(28, 28);

  test("near the forecast point is the forecast", async () => {
    const r = await ask(reachAt(ROCK), ring);
    expect(r.waterLevelDegraded).toBeUndefined();
    expect(r.explanation).toMatchObject({ waterLevel: 0.62, waterLevelSource: "fmi:forecast" });
  });

  test("far from the forecast is the fallback, marked degraded and never clear", async () => {
    // The vessel, and its forecast, 150 km north: its +0.62 m is not this sea's.
    const r = await ask(reachAt(offset(ROCK, 0, 150000)), ring);
    expect(r.waterLevelDegraded).toBe("no forecast within 30 km");
    expect(r.class).not.toBe("clear");
  });

  test("a ring whose edge cuts the reach between vertices outside it takes the lower of both", async () => {
    // Vertices 670 m from the centre, the southern edge 300 m from it; the forecast is below
    // the fallback, so the level there is the forecast's height with the fallback's reason.
    const low: WaterLevel = { h: -0.2, sigma: 0.14, source: "fmi:forecast" };
    const r = await ask(reachAt(offset(ROCK, 0, 300), 500, low), box(600, 10));
    expect(r.waterLevelDegraded).toBe("no forecast within 30 km");
    expect(r.explanation).toMatchObject({ waterLevel: -0.2, sigmaWaterLevel: 0.3 });
  });

  test("a ring inside the reach whose buffer crosses its edge counts as straddling it", async () => {
    // The ring's farthest vertex about 470 m from the centre, within 500 m; its buffer is not.
    const levels = reachAt(offset(ROCK, 0, -440), 500);
    expect((await ask(levels, ring)).waterLevelDegraded).toBeUndefined();
    expect((await ask(levels, ring, 100)).waterLevelDegraded).toBe("no forecast within 30 km");
  });
});

describe("UKC tile water level", () => {
  const [mx, my] = toMercator(ROCK[0], ROCK[1]);
  const t = tileAt(14, mx, my);
  const tile = (levels: AreaLevels): Buffer =>
    Buffer.from(ukcTileReply(14, t.x, t.y, deps(levels)).body as Uint8Array);
  const classes = (b: Buffer) => decodeMvt(b)[0]?.features.map((f) => f.properties.class) ?? [];

  test("a tile far from the forecast point is drawn at the fallback, with nothing clear", () => {
    const far = tile(reachAt(offset(ROCK, 0, 150000)));
    expect(far.equals(tile({ inside: lowerLevel(FORECAST, FALLBACK) }))).toBe(true);
    expect(classes(far)).not.toContain("clear");
  });

  test("a tile within the forecast's reach is drawn at the forecast", () => {
    const near = tile(reachAt(ROCK));
    expect(near.equals(tile({ inside: FORECAST }))).toBe(true);
    expect(classes(near)).toContain("clear");
  });
});
