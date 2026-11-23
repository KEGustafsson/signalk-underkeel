import fs from "fs";
import os from "os";
import path from "path";
import underkeel = require("../src/index");
import { parseConfig } from "../src/config";
import { corridorRing } from "../src/engine/route-check";
import type { LonLat } from "../src/foundation/geo";
import type { PlanningApiV1, Session, Status } from "../src/planning-api";
import { grownBox, PLANNING_API, planningApi, registerPlanningApi } from "../src/planning-api";
import type { RouteServiceDeps } from "../src/route-service";
import { toMercator } from "../src/foundation/geo";
import { RuleIndex } from "../src/spatial/rules";
import { RequestQueue, routeCheck } from "../src/route-service";
import { chartsProviderAt } from "./helpers/charts-provider";
import {
  CELLS,
  fixtureIndex,
  prepareFixtureIndex,
  ROCK,
  seedFixtureIndex
} from "./helpers/fixture-index";
import { fakeApp, fakeClock, T0 } from "./helpers/plugin-harness";
import { BRIDGE_GAP, bridgedChannel, CHANNEL_LAT, gappedChannel } from "./helpers/swept-channel";

/** The in-process planning API signalk-route-planner searches against. */

const NOW = Date.parse("2026-10-18T07:00:00Z");
const HOUR = 3_600_000;

function deps(over: Partial<RouteServiceDeps> = {}): RouteServiceDeps {
  return {
    index: fixtureIndex(),
    indexReason: undefined,
    config: parseConfig({}),
    vessel: () => ({ draft: 3.6, length: 12, beam: 4 }),
    waterLevel: () => ({ h: 0, sigma: 0.3, source: "chart-datum" }),
    getRoute: () => Promise.reject(new Error("no routes")),
    now: () => NOW,
    queue: new RequestQueue(),
    ...over
  };
}

const NEVER = new AbortController().signal;

async function inSession<T>(
  api: PlanningApiV1,
  job: (s: Session) => T,
  draft?: number
): Promise<T> {
  const r = await api.session(
    { departure: NOW, until: NOW + HOUR, speed: 3, draft },
    NEVER,
    async (s) => job(s)
  );
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.value;
}

const RANK: Record<Status, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };

/** A box d degrees of latitude high, centred on c, as wide on the ground. */
function boxAround(c: LonLat, d: number): [LonLat, LonLat] {
  const dLon = d / Math.cos((c[1] * Math.PI) / 180);
  return [
    [c[0] - dLon / 2, c[1] - d / 2],
    [c[0] + dLon / 2, c[1] + d / 2]
  ];
}

describe("planning API v1", () => {
  const api = planningApi(() => deps(), "signalk-underkeel test");

  test("a segment's verdict is the route check's verdict for the same leg", async () => {
    const a: LonLat = [22.004, 60.01];
    const b: LonLat = [22.03, 60.01];
    const viaApi = await inSession(api, (s) => s.segment(a, b));
    const reply = await routeCheck(
      {
        route: { type: "LineString", coordinates: [a, b] },
        departure: new Date(NOW).toISOString(),
        speed: 3
      },
      deps()
    );
    const leg = (reply.body as { legs: { status: Status; risk: number }[] }).legs[0];
    expect(viaApi.status).toBe(leg?.status);
    expect(viaApi.risk).toBe(leg?.risk);
    expect(viaApi.status).toBe("fail");
  });

  test("a box holding the rock fails at 3.6 m, and its verdict covers every leg inside it", async () => {
    const [sw, ne] = boxAround(ROCK, 0.002);
    const box = await inSession(api, (s) => s.box(sw, ne));
    expect(box.status).toBe("fail");
    // Every leg inside a box is at most as risky as the box with its buffer.
    const inside = await inSession(
      api,
      (s) => {
        const legs: Status[] = [];
        for (const c of [0.005, 0.02, 0.05]) {
          const [lo, hi] = boxAround([22.006, 60.0105], c / 10);
          const b = s.box(lo, hi);
          const leg = s.segment(lo, hi);
          legs.push(RANK[leg.status] <= RANK[b.status] ? "ok" : "fail");
        }
        return legs;
      },
      1.2
    );
    expect(inside).toEqual(["ok", "ok", "ok"]);
  });

  test("a deeper draft never gives a box a better status", async () => {
    const boxes = [0.001, 0.003, 0.008].flatMap((d) =>
      [ROCK, [22.006, 60.0105] as LonLat, [22.012, 59.9895] as LonLat].map((c) => boxAround(c, d))
    );
    const statuses = async (draft: number) =>
      inSession(api, (s) => boxes.map(([sw, ne]) => RANK[s.box(sw, ne).status]), draft);
    const shallow = await statuses(1.2);
    const deep = await statuses(3.6);
    expect(deep.every((r, i) => r >= (shallow[i] as number))).toBe(true);
  });

  test("a box over 25 km² with its buffer is refused", async () => {
    await expect(inSession(api, (s) => s.box([22, 60], [22.2, 60.1]))).rejects.toThrow(/25 km²/);
  });

  test("the session counts its work and is refused without an index or a draft", async () => {
    expect(
      await inSession(api, (s) => (s.segment([22.004, 60.01], [22.03, 60.01]), s.work()))
    ).toBeGreaterThan(0);
    const none = planningApi(() => deps({ index: undefined, indexReason: "building" }), "t");
    expect(none.unavailable()).toBe("building");
    const r = await none.session({ departure: NOW, until: NOW, speed: 3 }, NEVER, async () => 1);
    expect(r).toEqual({ ok: false, status: 503, error: "building" });
    const nodraft = planningApi(() => deps({ vessel: () => undefined }), "t");
    // The draft a session takes is stated while the vessel has one, never guessed.
    expect(api.defaults().draft).toBe(3.6);
    expect(nodraft.defaults()).not.toHaveProperty("draft");
    const v = await nodraft.session({ departure: NOW, until: NOW, speed: 3 }, NEVER, async () => 1);
    expect(v).toEqual({ ok: false, status: 422, error: "vessel draft not configured" });
  });

  test.each([
    [{ probability: Number.NaN }, /probability must be/],
    [{ probability: 0.9 }, /probability must be/],
    [{ speed: 0 }, /speed must be/],
    [{ speed: Number.POSITIVE_INFINITY }, /speed must be/],
    [{ xteLimit: -1 }, /xteLimit must be/],
    [{ draft: 0 }, /draft must be/],
    [{ airHeight: 0 }, /airHeight must be/],
    [{ airHeight: 101 }, /airHeight must be/],
    [{ waveHeight: -0.1 }, /waveHeight must be/],
    [{ waveHeight: 10.1 }, /waveHeight must be/],
    [{ waveHeight: Number.NaN }, /waveHeight must be/],
    [{ until: NOW - 1 }, /until not before departure/],
    [{ departure: Number.NaN }, /finite epoch ms/]
  ])("a session with %p is refused before it starts", async (over, message) => {
    let ran = false;
    const r = await api.session(
      { departure: NOW, until: NOW, speed: 3, ...over },
      NEVER,
      async () => {
        ran = true;
        return 1;
      }
    );
    expect(ran).toBe(false);
    expect(r.ok ? "" : `${r.status} ${r.error}`).toMatch(new RegExp(`^400 .*${message.source}`));
  });

  test("a session's air height holds its legs to a bridge at the window's highest water", async () => {
    const bridge = {
      objectClass: "BRIDGE" as const,
      geom: {
        type: "line" as const,
        coords: [toMercator(22.017, 60.005), toMercator(22.017, 60.015)]
      },
      cellRef: 0,
      clearance: 18
    };
    const base = fixtureIndex();
    const index = {
      ...base,
      catalogue: {
        ...base.catalogue,
        cells: base.catalogue.cells.map((c) => ({ ...c, verticalDatum: 3, soundingDatum: 3 }))
      },
      rules: new RuleIndex([bridge])
    };
    // High water only late in the window: the leg is held to it whenever the boat arrives.
    const highWater = (_start: number, end: number) => ({
      h: end > NOW + HOUR / 2 ? 1 : 0,
      sigma: 0.1,
      source: "test"
    });
    const tall = planningApi(
      () => deps({ index, vessel: () => ({ draft: 1.5, length: 12, beam: 4 }), highWater }),
      "test"
    );
    const leg = (airHeight?: number) =>
      tall.session(
        { departure: NOW, until: NOW + HOUR, speed: 3, ...(airHeight && { airHeight }) },
        NEVER,
        async (s) => ({
          v: s.segment([22.004, 60.01], [22.03, 60.01]),
          objects: s.objects([22.0, 60.0], [22.05, 60.02])
        })
      );
    const none = await leg();
    const mast = await leg(17);
    expect(none.ok && none.value.v.status).toBe("ok");
    expect(mast.ok && mast.value.v).toMatchObject({
      status: "fail",
      flags: expect.arrayContaining(["AIR_DRAFT"])
    });
    expect(mast.ok && mast.value.objects).toEqual([
      expect.objectContaining({ class: "BRIDGE", clearance: 18 })
    ]);
    expect(tall.features).toContain("objects");
  });

  test("a session's corridor is the cross-track limit and half the beam: no GPS buffer", async () => {
    const hull = (beam: number) =>
      planningApi(
        () =>
          deps({
            index: gappedChannel(),
            vessel: () => ({ draft: 1.5, length: 8, beam })
          }),
        "test"
      );
    const sw: LonLat = [22.002, CHANNEL_LAT];
    const ne: LonLat = [22.007, CHANNEL_LAT];
    const params = { departure: NOW, until: NOW + HOUR, speed: 3, xteLimit: 0 };
    const at = async (beam: number) => {
      const r = await hull(beam).session(params, NEVER, async (s) => ({
        halfWidth: s.halfWidth,
        box: s.box(sw, ne),
        leg: s.segment(sw, ne)
      }));
      if (!r.ok) {
        throw new Error("session refused");
      }
      return r.value;
    };
    // The channel is dredged 11 m each side: a 2.5 m beam keeps inside it.
    const small = await at(2.5);
    expect(small.halfWidth).toBe(1.25);
    expect(small.leg.status).toBe("ok");
    expect(small.box.status).toBe("ok");
    // A 30 m hull reaches its banks' 0 m.
    const wide = await at(30);
    expect(wide.halfWidth).toBe(15);
    expect(wide.leg.status).toBe("fail");
    expect(wide.box.status).toBe("fail");
  });

  test("a session holds a leg and a box through a fairway gap to its strip", async () => {
    const at = (beam: number) =>
      planningApi(
        () => deps({ index: bridgedChannel(), vessel: () => ({ draft: 1.5, length: 8, beam }) }),
        "test"
      );
    const a: LonLat = [22.006, CHANNEL_LAT];
    const b: LonLat = [22.014, CHANNEL_LAT];
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const sw: LonLat = [mid - 0.0002, CHANNEL_LAT];
    const ne: LonLat = [mid + 0.0002, CHANNEL_LAT];
    const params = { departure: NOW, until: NOW + HOUR, speed: 3, xteLimit: 0 };
    const r = await at(2.5).session(params, NEVER, async (s) => ({
      leg: s.segment(a, b),
      box: s.box(sw, ne)
    }));
    // A hull as wide as the strip (10 m each side) reaches past it, into the gap's charted 0 m.
    const wide = await at(24).session(params, NEVER, async (s) => s.segment(a, b));
    if (!r.ok || !wide.ok) {
      throw new Error("session refused");
    }
    expect(r.value.leg.status).toBe("ok");
    expect(r.value.leg.flags).toContain("FAIRWAY_GAP");
    expect(r.value.box.flags).toContain("FAIRWAY_GAP");
    expect(wide.value.status).toBe("fail");
    expect(wide.value.flags).not.toContain("FAIRWAY_GAP");
  });

  test("no pilotage feature: a plan reads no GPS", () => {
    expect(api.features).not.toContain("pilotage");
  });

  test("a leg whose corridor is over 25 km² is refused", async () => {
    // 400 km at the default 40 m half-width: (400 km) × 80 m = 32 km².
    await expect(inSession(api, (s) => s.segment([22, 60], [29.2, 60]))).rejects.toThrow(/25 km²/);
  });

  test("an aborted request stops at its next pause", async () => {
    const ctl = new AbortController();
    const r = await api.session({ departure: NOW, until: NOW, speed: 3 }, ctl.signal, async (s) => {
      ctl.abort(new Error("client gone"));
      await s.pause();
      return 1;
    });
    expect(r).toEqual({ ok: false, status: 503, error: "client gone" });
  });

  test("the grown box holds the corridor of every leg inside it, great-circle bulge and all", () => {
    // A leg along the box's poleward edge at 60° N bows north of it on the great circle.
    const sw: [number, number] = [22, 60];
    const ne: [number, number] = [22.09, 60.04];
    const r = 40;
    const k = Math.PI / 180;
    const unit = ([lon, lat]: [number, number]): [number, number, number] => [
      Math.cos(lat * k) * Math.cos(lon * k),
      Math.cos(lat * k) * Math.sin(lon * k),
      Math.sin(lat * k)
    ];
    const [ax, ay, az] = unit([sw[0], ne[1]]);
    const [bx, by, bz] = unit([ne[0], ne[1]]);
    const midLat = Math.atan2(az + bz, Math.hypot(ax + bx, ay + by)) / k;
    expect(midLat).toBeGreaterThan(ne[1]);
    const ring = grownBox(sw, ne, r);
    // The ring's north edge is past the great circle's midpoint by at least r.
    expect((ring[2] as [number, number])[1]).toBeGreaterThanOrEqual(midLat + r / 111195);
  });

  test("the grown box holds the corner of a diagonal leg's corridor ring", () => {
    // Corner to corner: the ring's corners lie r√2 past each end, beyond an r-grown box.
    const sw: LonLat = [22, 60];
    const ne: LonLat = [22.02, 60.01];
    const r = 40;
    const ring = grownBox(sw, ne, r);
    const [w, s] = ring[0] as LonLat;
    const [e, n] = ring[2] as LonLat;
    const corners = [...corridorRing(sw, ne, r), ...corridorRing(ne, sw, r)];
    const outside = corners.filter(([x, y]) => x < w || x > e || y < s || y > n);
    expect(outside).toEqual([]);
  });

  test("the grown box holds every point within r of the box", () => {
    const ring = grownBox([22, 60], [22.01, 60.01], 1000);
    expect(ring[0]?.[1]).toBeLessThanOrEqual(60 - 1000 / 111195);
    expect(ring[2]?.[0]).toBeGreaterThan(
      22.01 + 1000 / (111195 * Math.cos((60.01 * Math.PI) / 180)) - 1e-9
    );
  });
});

describe("registration", () => {
  const g = globalThis as unknown as Record<symbol, unknown>;

  test("an unregister removes only its own API", () => {
    const a = planningApi(() => deps(), "a");
    const b = planningApi(() => deps(), "b");
    const offA = registerPlanningApi(a);
    const offB = registerPlanningApi(b);
    offA();
    expect(g[PLANNING_API]).toBe(b);
    offB();
    expect(g[PLANNING_API]).toBeUndefined();
  });

  test("the plugin publishes the API while it runs and removes it on stop", async () => {
    await prepareFixtureIndex();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-planning-"));
    try {
      const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 2.0 } } });
      const plugin = underkeel(f.app, fakeClock(T0));
      seedFixtureIndex(dataDir);
      plugin.start({ ...chartsProviderAt(CELLS), boxRadiusKm: 0, leafZoom: 18 }, () => undefined);
      const api = g[PLANNING_API] as PlanningApiV1;
      expect(api.version).toBe(1);
      expect(api.provider).toMatch(/^signalk-underkeel \d+\.\d+\.\d+/);
      plugin.stop();
      expect(g[PLANNING_API]).toBeUndefined();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
