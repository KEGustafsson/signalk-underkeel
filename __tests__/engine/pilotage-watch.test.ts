import type { Delta } from "@signalk/server-api";
import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../../src/config";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import { legAt, offset, ON_ROUTE, pilotageVerdict } from "../../src/engine/pilotage-watch";
import type { LonLat } from "../../src/foundation/geo";
import { PATHS } from "../../src/foundation/state";
import type { IntegrityResult } from "../../src/model/integrity";
import type { Clock } from "../../src/monitor";
import { Monitor } from "../../src/monitor";
import {
  PilotageService,
  PilotageWatch,
  ROUTE_RETRY_MS,
  routeCoordinates,
  routeIdOf
} from "../../src/pilotage-watch";
import { navDelta } from "../helpers/plugin-harness";
import { CHANNEL_LAT, gappedChannel } from "../helpers/swept-channel";

/**
 * Pilotage underway (`engine/pilotage-watch.ts`, `pilotage-watch.ts`): the live fix held to the
 * room of the active route's swept leg the boat is on, on the synthetic channel dredged 11 m
 * each side of its line.
 */

const M = 1 / 111_320;
const west: LonLat[] = [
  [22.002, CHANNEL_LAT],
  [22.007, CHANNEL_LAT]
];
const ON_LINE: LonLat = [22.004, CHANNEL_LAT];

describe("the leg the boat is on", () => {
  test("the nearest within ON_ROUTE metres, or none", () => {
    const legs = [
      { from: west[0] as LonLat, to: west[1] as LonLat },
      { from: west[1] as LonLat, to: [22.007, CHANNEL_LAT + 0.01] as LonLat }
    ];
    expect(legAt(ON_LINE, legs)).toBe(0);
    expect(legAt([22.007, CHANNEL_LAT + 0.005], legs)).toBe(1);
    expect(legAt([22.004, CHANNEL_LAT + (ON_ROUTE + 5) * M], legs)).toBeUndefined();
    expect(
      offset([22.004, CHANNEL_LAT + 20 * M], west[0] as LonLat, west[1] as LonLat).d
    ).toBeCloseTo(20, 0);
  });
});

describe("the pilotage verdict", () => {
  test("normal while the fix holds within the room, a warning when it is wider or untrusted", () => {
    expect(pilotageVerdict(0, 6, 3).state).toBe("normal");
    const wide = pilotageVerdict(3, 6, 7.2);
    expect(wide.state).toBe("warn");
    expect(wide.message).toMatch(/±7\.2 m.*leg 4.*±6\.0 m/);
    expect(wide.data).toEqual({ leg: 4, room: 6, need: 7.2 });
    expect(pilotageVerdict(0, 6, undefined).state).toBe("warn");
  });
});

describe("the active route", () => {
  test("its id from the course API's href, its legs from the route resource", () => {
    expect(routeIdOf("/resources/routes/ab%20c")).toBe("ab c");
    expect(routeIdOf("/resources/routes/%C3%A5")).toBe("å");
    expect(routeIdOf("/resources/routes/%")).toBeUndefined();
    expect(routeIdOf("/resources/routes/a%E0%A4%A")).toBeUndefined();
    expect(routeIdOf("/resources/waypoints/x")).toBeUndefined();
    expect(routeIdOf(undefined)).toBeUndefined();
    const line = { feature: { geometry: { type: "LineString", coordinates: [...west, [1]] } } };
    expect(routeCoordinates(line)).toEqual(west);
    expect(routeCoordinates({ feature: { geometry: { type: "Point" } } })).toBeUndefined();
  });
});

/** A server with `route` the active route, and the deltas it is sent. */
function server(route: LonLat[] | undefined) {
  const sent: { path: string; value: { state: string; message: string } }[] = [];
  return {
    sent,
    app: {
      getSelfPath: (p: string) =>
        p === "navigation.course.activeRoute" && route
          ? { value: { href: "/resources/routes/r1" } }
          : undefined,
      resourcesApi: {
        getResource: (type: string, id: string) =>
          type === "routes" && id === "r1"
            ? Promise.resolve({
                feature: { geometry: { type: "LineString", coordinates: route } }
              })
            : Promise.reject(new Error("no such route"))
      },
      handleMessage: (
        _id: string,
        delta: { updates: { values: { path: string; value: never }[] }[] }
      ) => sent.push(...(delta.updates[0]?.values ?? []))
    }
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const fix = (sigmaPos: number, ok = true): IntegrityResult => ({
  sigmaPos,
  ok,
  reasons: ok ? [] : ["HDOP 9.0"],
  divergence: null
});

describe("the pilotage watch", () => {
  const index = gappedChannel();
  /** Up to a 15 m least buffer, past a 2.5 m beam's half. */
  const C = { least: 15, hull: 1.25 };

  test("a swept leg's room, measured once on the chart index in use", async () => {
    const { app } = server(west);
    const watch = new PilotageWatch(app as never);
    expect(watch.check(index, ON_LINE, 3, C)).toBeUndefined();
    await flush();
    const v = watch.check(index, ON_LINE, 3, C);
    expect(v?.state).toBe("normal");
    // Dredged 11 m each side: past the hull's 1.25 m, less a tile at the edge.
    expect(v?.data.room).toBeGreaterThanOrEqual(3);
    expect(v?.data.room).toBeLessThanOrEqual(9.75);
    expect(watch.check(index, ON_LINE, 12, C)?.state).toBe("warn");
    // Room as wide as the least buffer: the plan needs no pilotage there.
    expect(watch.check(index, ON_LINE, 3, { least: 2.5, hull: 1.25 })).toBeUndefined();
  });

  test("nothing without an active route, off it, or on a leg not in swept water", async () => {
    const none = new PilotageWatch(server(undefined).app as never);
    expect(none.check(index, ON_LINE, 3, C)).toBeUndefined();
    const across = new PilotageWatch(
      server([
        [22.006, CHANNEL_LAT],
        [22.014, CHANNEL_LAT]
      ]).app as never
    );
    across.check(index, [22.01, CHANNEL_LAT], 3, C);
    await flush();
    expect(across.check(index, [22.01, CHANNEL_LAT], 3, C)).toBeUndefined();
    const far: LonLat = [22.004, CHANNEL_LAT + 0.002];
    const w = new PilotageWatch(server(west).app as never);
    w.check(index, far, 3, C);
    await flush();
    expect(w.check(index, far, 3, C)).toBeUndefined();
  });

  test("an href whose id does not decode is no active route, and loads nothing", () => {
    let loads = 0;
    const app = {
      getSelfPath: () => ({ value: { href: "/resources/routes/%" } }),
      resourcesApi: {
        getResource: () => {
          loads++;
          return Promise.reject(new Error("no such route"));
        }
      }
    };
    const w = new PilotageWatch(app as never);
    expect(w.check(index, ON_LINE, 3, C)).toBeUndefined();
    expect(loads).toBe(0);
  });

  test("a failed load is asked for again ROUTE_RETRY_MS later, not before", async () => {
    let fail = true;
    let loads = 0;
    const errors: string[] = [];
    const app = {
      getSelfPath: () => ({ value: { href: "/resources/routes/r1" } }),
      resourcesApi: {
        getResource: () => {
          loads++;
          return fail
            ? Promise.reject(new Error("busy"))
            : Promise.resolve({ feature: { geometry: { type: "LineString", coordinates: west } } });
        }
      }
    };
    const w = new PilotageWatch(app as never, (m) => errors.push(m));
    const T = 1_000_000;
    w.check(index, ON_LINE, 3, C, T);
    await flush();
    fail = false;
    expect(w.check(index, ON_LINE, 3, C, T + ROUTE_RETRY_MS - 1)).toBeUndefined();
    await flush();
    expect(loads).toBe(1);
    w.check(index, ON_LINE, 3, C, T + ROUTE_RETRY_MS);
    await flush();
    expect(w.check(index, ON_LINE, 3, C, T + ROUTE_RETRY_MS)?.state).toBe("normal");
    expect([loads, errors]).toEqual([2, ["active route r1: busy"]]);
  });

  test("only the latest load is taken: route A, then B, then A again", async () => {
    let href = "/resources/routes/a";
    const pending: { resolve: (r: unknown) => void; reject: (e: Error) => void }[] = [];
    const errors: string[] = [];
    const app = {
      getSelfPath: () => ({ value: { href } }),
      resourcesApi: {
        getResource: () =>
          new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
          })
      }
    };
    const line = (c: LonLat[]) => ({
      feature: { geometry: { type: "LineString", coordinates: c } }
    });
    const w = new PilotageWatch(app as never, (m) => errors.push(m));
    const T = 1_000_000;
    w.check(index, ON_LINE, 3, C, T);
    href = "/resources/routes/b";
    w.check(index, ON_LINE, 3, C, T);
    href = "/resources/routes/a";
    w.check(index, ON_LINE, 3, C, T);
    const [first, second, third] = pending;
    // The latest A, then the first A's answer and B's failure, both late: neither is taken.
    third?.resolve(line(west));
    first?.resolve(
      line([
        [22.004, CHANNEL_LAT + 0.01],
        [22.007, CHANNEL_LAT + 0.01]
      ])
    );
    second?.reject(new Error("gone"));
    await flush();
    expect(w.check(index, ON_LINE, 3, C, T + ROUTE_RETRY_MS)?.state).toBe("normal");
    expect([pending.length, errors]).toEqual([3, []]);
  });

  describe("as a service", () => {
    test("the verdict reads the fix and integrity check of the moment, also with no new position", async () => {
      const { app, sent } = server(west);
      let now = Date.parse("2026-11-22T12:00:00Z");
      const clock: Clock = {
        now: () => now,
        setInterval: () => 1,
        clearInterval: () => undefined,
        defer: (fn) => fn,
        cancel: () => undefined
      };
      const harness = {
        ...app,
        getSelfPath: (p: string) =>
          p === "design.draft" ? { value: { maximum: 1.5 } } : app.getSelfPath(p),
        setPluginStatus: () => undefined,
        setPluginError: () => undefined,
        error: () => undefined,
        subscriptionmanager: { subscribe: () => undefined }
      };
      const config = parseConfig({
        waterLevel: { source: "manual", height: 0 },
        lookahead: { positionBuffer: 15 }
      });
      const monitor = new Monitor(harness as never, "underkeel", config, index, undefined, clock);
      const s = new PilotageService(
        harness as never,
        "underkeel",
        () => config.lookahead,
        () => undefined
      );
      s.attach(monitor, () => index, clock.now);
      monitor.start();
      const hdop = (v: number) => ({
        updates: [
          {
            timestamp: new Date(now).toISOString() as never,
            values: [{ path: "navigation.gnss.horizontalDilution" as never, value: v }]
          }
        ]
      });
      const tick = (...deltas: Delta[]) => {
        now += 1000;
        deltas.forEach((d) => {
          monitor.onDelta(d);
        });
        monitor.tick();
      };
      const pilotage = () => sent.filter((d) => d.path === PATHS.pilotage).at(-1)?.value;
      tick(hdop(1), navDelta(ON_LINE[0], ON_LINE[1], 0, now + 1000));
      await flush();
      tick(navDelta(ON_LINE[0], ON_LINE[1], 0, now + 1000));
      expect(pilotage()?.state).toBe("normal");
      // A fix arriving with a failing HDOP warns on its own tick.
      tick(hdop(9), navDelta(ON_LINE[0], ON_LINE[1], 0, now + 1000));
      expect(pilotage()?.message).toMatch(/cannot be trusted/);
      // The HDOP recovering, the position unchanged, lifts it on the next tick.
      tick(hdop(1));
      expect(pilotage()?.state).toBe("normal");
      monitor.stop();
    });

    test("notifies by the live fix, clears off the route, on a stale position and on stop", async () => {
      const { app, sent } = server(west);
      const opts = { ...DEFAULT_LOOKAHEAD, positionBuffer: 15 };
      const s = new PilotageService(
        app as never,
        "underkeel",
        () => opts,
        () => undefined
      );
      const NOW = Date.parse("2026-11-22T12:00:00Z");
      const at = (p: LonLat, sigma: number, t: number, ok = true) =>
        s.tick({
          integrity: fix(sigma, ok),
          index,
          position: { value: p, at: t },
          hull: 1.25,
          now: t
        });
      at(ON_LINE, 1, NOW);
      await flush();
      at(ON_LINE, 1, NOW + 1000);
      const own = sent.filter((d) => d.path === PATHS.pilotage);
      expect(own.at(-1)?.value.state).toBe("normal");
      at(ON_LINE, 7, NOW + 2000);
      expect(own.length).toBeLessThan(sent.filter((d) => d.path === PATHS.pilotage).length);
      expect(sent.at(-1)?.value.state).toBe("warn");
      at(ON_LINE, 1, NOW + 3000, false);
      expect(sent.at(-1)?.value.message).toMatch(/cannot be trusted/);
      at([22.004, CHANNEL_LAT + 0.002], 1, NOW + 4000);
      expect(sent.at(-1)?.value.state).toBe("normal");
      // A stale position gives no verdict, even with a wide fix.
      at(ON_LINE, 1, NOW + 5000);
      const before = sent.length;
      s.tick({
        integrity: fix(7),
        index,
        position: { value: ON_LINE, at: NOW },
        hull: 1.25,
        now: NOW + 60_000
      });
      expect(sent.slice(before).every((d) => d.value.state === "normal")).toBe(true);
      at(ON_LINE, 7, NOW + 61_000);
      expect(sent.at(-1)?.value.state).toBe("warn");
      s.stop();
      expect(sent.at(-1)?.value.message).toBe("UKC monitoring stopped");
    });
  });
});
