import { parseConfig } from "../src/config";
import type { QueryResult } from "../src/engine/query";
import type { LonLat } from "../src/foundation/geo";
import { haversine } from "../src/foundation/geo";
import type { WaterLevel } from "../src/model/uncertainty";
import type { QueryServiceDeps } from "../src/query-service";
import { query } from "../src/query-service";
import { RequestQueue } from "../src/route-service";
import { fixtureIndex, ROCK } from "./helpers/fixture-index";

/** `POST /query` takes the water level where it is asked, not where the vessel is (plan §4.5). */

/** A forecast fetched at `at` that answers within 30 km of it, as FMI does, else falls back. */
function forecastAt(at: LonLat) {
  const asked: (readonly LonLat[] | undefined)[] = [];
  const level = (where?: readonly LonLat[]): WaterLevel => {
    asked.push(where);
    return (where ?? []).every((p) => haversine(p, at) <= 30000)
      ? { h: 0.62, sigma: 0.14, source: "fmi:forecast" }
      : { h: 0, sigma: 0.3, source: "fallback", degraded: "no forecast within 30 km" };
  };
  return { asked, level };
}

async function ask(at: LonLat, ring: LonLat[]): Promise<{ r: QueryResult; asked: unknown[] }> {
  const { asked, level } = forecastAt(at);
  const deps: QueryServiceDeps = {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({ vessel: { draft: 2, length: 12, beam: 4 } }),
    vessel: () => ({ draft: 2, length: 12, beam: 4 }),
    waterLevel: level,
    waveHeight: () => undefined
  };
  const reply = await query(
    { geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } },
    deps,
    new RequestQueue(),
    new AbortController().signal
  );
  expect(reply.status).toBe(200);
  return { r: reply.body as QueryResult, asked };
}

describe("POST /query water level", () => {
  const d = 0.0005;
  const ring: LonLat[] = [
    [ROCK[0] - d, ROCK[1] - d / 2],
    [ROCK[0] + d, ROCK[1] - d / 2],
    [ROCK[0] + d, ROCK[1] + d / 2],
    [ROCK[0] - d, ROCK[1] + d / 2]
  ];

  test("is resolved at the queried ring", async () => {
    const { r, asked } = await ask(ROCK, ring);
    expect(asked).toEqual([ring]);
    expect(r.waterLevelDegraded).toBeUndefined();
  });

  test("far from the forecast is the fallback, marked degraded and never clear", async () => {
    // The vessel, and its forecast, 150 km north: its +0.62 m is not this sea's.
    const { r } = await ask([ROCK[0], ROCK[1] + 1.35], ring);
    expect(r.waterLevelDegraded).toBe("no forecast within 30 km");
    expect(r.class).not.toBe("clear");
  });
});
