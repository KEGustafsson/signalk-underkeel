import { UkcTileChanges } from "../src/api/ukc-tile-changes";
import type { TileChanges } from "../src/api/ukc-tile-changes";
import { parseConfig } from "../src/config";
import { UkcTileCache } from "../src/engine/ukc-tile-geometry";
import type { LonLat } from "../src/foundation/geo";
import { haversine, offset, tileAt, toMercator } from "../src/foundation/geo";
import type { AreaLevels } from "../src/model/level-regimes";
import { tileCorners, withinReach } from "../src/model/level-regimes";
import type { WaterLevel } from "../src/model/uncertainty";
import type { QueryServiceDeps } from "../src/query-service";
import { ukcTileChangesReply, ukcTileReply } from "../src/query-service";
import { cacheOf } from "../src/spatial/block-cache";
import type { ChartIndex } from "../src/spatial/chart-index";
import { pyramidFromBuffer, serializePyramid } from "../src/spatial/store";
import { fixtureIndex, ROCK } from "./helpers/fixture-index";

/** What a plotter holding the UKC tiles sees: GET /tiles/ukc/changes against the tiles served. */

interface Level {
  h: number;
  sigma?: number;
  waves?: number;
  degraded?: string;
  /** The level beyond a source's reach, and where that reach is. */
  beyond?: { h: number; sigma?: number; degraded?: string; centre: LonLat; metres: number };
}

const levelOf = (l: { h: number; sigma?: number; degraded?: string }): WaterLevel => ({
  h: l.h,
  sigma: l.sigma ?? 0.1,
  source: "manual",
  ...(l.degraded ? { degraded: l.degraded } : {})
});

/** The 3 × 3 tiles around ROCK at z12, z14 and z16. */
function rockTiles(): [number, number, number][] {
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
  return tiles;
}

function feed(
  level: Level,
  lookahead: Record<string, unknown> = {},
  index: ChartIndex = fixtureIndex(),
  prefetch = true
) {
  const tileChanges = new UkcTileChanges();
  const deps: QueryServiceDeps = {
    index,
    indexReason: undefined,
    config: parseConfig({ vessel: { draft: 3.2, length: 12, beam: 4 }, lookahead }),
    vessel: () => ({ draft: 3.2, length: 12, beam: 4 }),
    levelRegimes: (): AreaLevels => {
      const b = level.beyond;
      const inside = levelOf(level);
      return b
        ? {
            inside,
            beyond: {
              level: { ...levelOf(b), sigma: b.sigma ?? 0.3, source: "fallback" },
              reach: { centre: b.centre, metres: b.metres }
            }
          }
        : { inside };
    },
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
  const tiles = rockTiles();
  if (prefetch) {
    tiles.forEach(([z, x, y]) => fetchTile(z, x, y));
  }
  let cursor = ukcTileChangesReply({}, deps).body as TileChanges;
  const poll = (): TileChanges => {
    const reply = ukcTileChangesReply({ epoch: cursor.epoch, rev: String(cursor.rev) }, deps)
      .body as TileChanges;
    cursor = reply;
    return reply;
  };
  /** Every tile held is byte for byte the tile the server draws now. */
  // One assertion per poll, not per tile (§7 Test runtime): no held tile is stale.
  const current = (step?: number) => {
    const stale = [...held]
      .filter(([k, copy]) => {
        const [z, x, y] = k.split("/").map(Number) as [number, number, number];
        return !Buffer.from(ukcTileReply(z, x, y, deps).body as Uint8Array).equals(copy);
      })
      .map(([k]) => k);
    expect({ step, stale }).toEqual({ step, stale: [] });
  };
  return { deps, held, tiles, fetchTile, poll, current };
}

/** The farthest corner of any tile at zoom `z` in `tiles` from `p`, metres. */
const farthest = (tiles: [number, number, number][], z: number, p: LonLat): number =>
  Math.max(
    ...tiles
      .filter((t) => t[0] === z)
      .flatMap(([tz, x, y]) => tileCorners(tz, x, y).map((c) => haversine(c, p)))
  );

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
      f.current(i);
    }
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan((160 * f.tiles.length) / 4);
  });

  test("with a level source's reach, an unlisted tile is current as either level or the reach moves", () => {
    const tiles = rockTiles();
    // Every z16 tile within the reach and some z12 tiles beyond it.
    const metres = (farthest(tiles, 16, ROCK) + farthest(tiles, 12, ROCK)) / 2;
    const beyond: NonNullable<Level["beyond"]> = {
      h: 0,
      degraded: "no forecast here",
      centre: ROCK,
      metres
    };
    const level: Level = { h: 0.8, beyond };
    const f = feed(level);
    const inside = (c: LonLat) =>
      f.tiles.filter(([z, x, y]) => withinReach({ centre: c, metres }, tileCorners(z, x, y)));
    expect(inside(ROCK).length).toBeGreaterThan(0);
    expect(inside(ROCK).length).toBeLessThan(f.tiles.length);
    let partial = 0;
    let flipped = 0;
    for (let i = 1; i <= 40; i++) {
      level.h = 0.8 - 0.01 * i;
      if (i % 3 === 0) {
        beyond.h = -0.02 * (i % 4);
      }
      if (i % 5 === 0) {
        // The forecast point moves 2.5 km east or back: tiles cross the reach edge.
        const was = new Set(inside(beyond.centre));
        beyond.centre = offset(ROCK, i % 10 === 0 ? 0 : 2500, 0);
        const now = new Set(inside(beyond.centre));
        flipped += f.tiles.filter((t) => was.has(t) !== now.has(t)).length;
      }
      const reply = f.poll();
      expect(reply.all).toBe(false);
      if (reply.tiles.length > 0 && reply.tiles.length < f.tiles.length) {
        partial++;
      }
      reply.tiles.forEach(([z, x, y]) => f.fetchTile(z, x, y));
      f.current();
    }
    expect(flipped).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(0);
  });

  test("the beyond level's sigma or fallback flag, or the reach coming or going, refreshes every tile", () => {
    const tiles = rockTiles();
    const metres = (farthest(tiles, 16, ROCK) + farthest(tiles, 12, ROCK)) / 2;
    const beyond: NonNullable<Level["beyond"]> = { h: 0, sigma: 0.3, centre: ROCK, metres };
    const level: Level = { h: 0.3, beyond };
    const f = feed(level);
    expect(f.poll()).toMatchObject({ all: false, tiles: [] });
    beyond.sigma = 0.4;
    expect(f.poll().all).toBe(true);
    beyond.degraded = "no forecast here";
    expect(f.poll().all).toBe(true);
    expect(f.poll()).toMatchObject({ all: false, tiles: [] });
    delete level.beyond;
    expect(f.poll().all).toBe(true);
    level.beyond = beyond;
    expect(f.poll().all).toBe(true);
  });

  test("a wave height change or a fallback water level refreshes every tile", () => {
    const level: Level = { h: 0.3 };
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
      f.current();
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

  test("a tile drawn from stand-ins is listed once its block loads", () => {
    // Every block starts unloaded and loads only when asked, as one over syncBytes does.
    const base = fixtureIndex();
    const file = serializePyramid(base.pyramid, { residentZoom: 15, blockZoom: 13 });
    const pyramid = pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: -1 });
    const blocks = cacheOf(pyramid);
    expect(blocks).toBeDefined();
    const f = feed({ h: 0.3 }, {}, { ...base, pyramid });
    let listed = 0;
    for (const key of blocks?.keys() ?? []) {
      blocks?.loadNow(key);
      const reply = f.poll();
      expect(reply.all).toBe(false);
      reply.tiles.forEach(([z, x, y]) => f.fetchTile(z, x, y));
      listed += reply.tiles.length;
      f.current();
    }
    expect(listed).toBeGreaterThan(0);
    expect(f.poll()).toMatchObject({ all: false, tiles: [] });
  });

  test("a tile is not listed for the small blocks its own drawing read", () => {
    // Every block small enough to read on the spot: drawing a tile loads the blocks it reaches.
    const base = fixtureIndex();
    const file = serializePyramid(base.pyramid, { residentZoom: 15, blockZoom: 13 });
    const pyramid = pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: Infinity });
    const blocks = cacheOf(pyramid);
    const f = feed({ h: 0.3 }, {}, { ...base, pyramid }, false);
    const [z, x, y] = f.tiles[f.tiles.length - 5] as [number, number, number];
    f.fetchTile(z, x, y);
    expect(blocks?.loads).toBeGreaterThan(0);
    expect(f.poll()).toMatchObject({ all: false, tiles: [] });
    f.current();
    // Tiles drawn before a neighbour loaded a block they reach read its stand-ins: still listed
    // when their copy may differ, and every tile left unlisted is current.
    f.tiles.forEach(([tz, tx, ty]) => f.fetchTile(tz, tx, ty));
    const reply = f.poll();
    expect(reply.all).toBe(false);
    reply.tiles.forEach(([tz, tx, ty]) => f.fetchTile(tz, tx, ty));
    f.current();
    const loads = blocks?.loads;
    expect(f.poll()).toMatchObject({ all: false, tiles: [] });
    expect(blocks?.loads).toBe(loads);
  });
});
