import { UkcTileChanges } from "../src/api/ukc-tile-changes";
import type { TileChanges } from "../src/api/ukc-tile-changes";
import { parseConfig } from "../src/config";
import { UkcTileCache } from "../src/engine/ukc-tile-geometry";
import { tileAt, toMercator } from "../src/foundation/geo";
import type { WaterLevel } from "../src/model/uncertainty";
import type { QueryServiceDeps } from "../src/query-service";
import { ukcTileChangesReply, ukcTileReply } from "../src/query-service";
import { fixtureIndex, ROCK } from "./helpers/fixture-index";

/** What a plotter holding the UKC tiles sees: GET /tiles/ukc/changes against the tiles served. */

function feed(
  level: { h: number; sigma?: number; waves?: number; degraded?: string },
  lookahead: Record<string, unknown> = {}
) {
  const tileChanges = new UkcTileChanges();
  const deps: QueryServiceDeps = {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({ vessel: { draft: 3.2, length: 12, beam: 4 }, lookahead }),
    vessel: () => ({ draft: 3.2, length: 12, beam: 4 }),
    waterLevel: (): WaterLevel => ({
      h: level.h,
      sigma: level.sigma ?? 0.1,
      source: "manual",
      ...(level.degraded ? { degraded: level.degraded } : {})
    }),
    waveHeight: () => level.waves,
    tileChanges,
    tileCache: new UkcTileCache()
  };
  const held = new Map<string, Buffer>();
  const fetchTile = (z: number, x: number, y: number) => {
    const r = ukcTileReply(z, x, y, deps);
    expect(r.status).toBe(200);
    held.set(`${z}/${x}/${y}`, Buffer.from(r.body as Uint8Array));
  };
  const tiles: [number, number, number][] = [];
  for (const z of [12, 14, 16]) {
    const [mx, my] = toMercator(ROCK[0], ROCK[1]);
    const t = tileAt(z, mx, my);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        tiles.push([z, t.x + dx, t.y + dy]);
      }
    }
  }
  tiles.forEach(([z, x, y]) => fetchTile(z, x, y));
  let cursor = ukcTileChangesReply({}, deps).body as TileChanges;
  const poll = (): TileChanges => {
    const reply = ukcTileChangesReply({ epoch: cursor.epoch, rev: String(cursor.rev) }, deps)
      .body as TileChanges;
    cursor = reply;
    return reply;
  };
  return { deps, held, tiles, fetchTile, poll };
}

describe("UKC tile change feed", () => {
  test("a tile left unlisted after a water-level move is byte for byte the tile served now", () => {
    const level = { h: 0.8 };
    const f = feed(level);
    let listed = 0;
    for (let i = 1; i <= 160; i++) {
      // Down 1.6 m and back up, in 1 cm steps.
      level.h = 0.8 - 0.01 * (i <= 80 ? i : 160 - i);
      const reply = f.poll();
      expect(reply.all).toBe(false);
      reply.tiles.forEach(([z, x, y]) => f.fetchTile(z, x, y));
      listed += reply.tiles.length;
      for (const [z, x, y] of f.tiles) {
        const now = Buffer.from(ukcTileReply(z, x, y, f.deps).body as Uint8Array);
        expect(now.equals(f.held.get(`${z}/${x}/${y}`) as Buffer)).toBe(true);
      }
    }
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan((160 * f.tiles.length) / 4);
  });

  test("a wave height change or a fallback water level refreshes every tile", () => {
    const level: { h: number; waves?: number; degraded?: string } = { h: 0.3 };
    const f = feed(level);
    expect(f.poll()).toMatchObject({ all: false, tiles: [] });
    level.waves = 1.5;
    expect(f.poll().all).toBe(true);
    expect(f.poll()).toMatchObject({ all: false, tiles: [] });
    level.degraded = "FMI forecast unavailable";
    expect(f.poll().all).toBe(true);
  });

  test("a forecast sigma growing by the millimetre lists no tile until it passes a centimetre", () => {
    const level = { h: 0.3, sigma: 0.101 };
    const f = feed(level);
    for (let i = 1; i <= 8; i++) {
      level.sigma = 0.101 + 0.001 * i;
      expect(f.poll()).toMatchObject({ all: false, tiles: [] });
      for (const [z, x, y] of f.tiles) {
        const now = Buffer.from(ukcTileReply(z, x, y, f.deps).body as Uint8Array);
        expect(now.equals(f.held.get(`${z}/${x}/${y}`) as Buffer)).toBe(true);
      }
    }
    level.sigma = 0.111;
    expect(f.poll().all).toBe(true);
  });

  test("with a warn level above 1/2 tiles keep the exact sigma, so a millimetre refreshes them", () => {
    const level = { h: 0.3, sigma: 0.101 };
    const f = feed(level, { warnRisk: 0.6 });
    level.sigma = 0.102;
    expect(f.poll().all).toBe(true);
  });
});
