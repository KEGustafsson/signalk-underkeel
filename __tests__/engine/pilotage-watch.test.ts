import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_LOOKAHEAD } from "../../src/engine/lookahead";
import { legAt, offset, ON_ROUTE, pilotageVerdict } from "../../src/engine/pilotage-watch";
import { FixHistoryStore } from "../../src/fix-history-store";
import type { LonLat } from "../../src/foundation/geo";
import { PATHS } from "../../src/foundation/state";
import type { IntegrityResult } from "../../src/model/integrity";
import {
  PilotageService,
  PilotageWatch,
  routeCoordinates,
  routeIdOf
} from "../../src/pilotage-watch";
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

  test("a swept leg's room, measured once on the chart index in use", async () => {
    const { app } = server(west);
    const watch = new PilotageWatch(app as never);
    expect(watch.check(index, ON_LINE, 3, 15)).toBeUndefined();
    await flush();
    const v = watch.check(index, ON_LINE, 3, 15);
    expect(v?.state).toBe("normal");
    expect(v?.data.room).toBeGreaterThanOrEqual(2);
    expect(v?.data.room).toBeLessThanOrEqual(11);
    expect(watch.check(index, ON_LINE, 12, 15)?.state).toBe("warn");
    // Room as wide as the least buffer: the plan needs no pilotage there.
    expect(watch.check(index, ON_LINE, 3, 2.5)).toBeUndefined();
  });

  test("nothing without an active route, off it, or on a leg not in swept water", async () => {
    const none = new PilotageWatch(server(undefined).app as never);
    expect(none.check(index, ON_LINE, 3, 15)).toBeUndefined();
    const across = new PilotageWatch(
      server([
        [22.006, CHANNEL_LAT],
        [22.014, CHANNEL_LAT]
      ]).app as never
    );
    across.check(index, [22.01, CHANNEL_LAT], 3, 15);
    await flush();
    expect(across.check(index, [22.01, CHANNEL_LAT], 3, 15)).toBeUndefined();
    const far: LonLat = [22.004, CHANNEL_LAT + 0.002];
    const w = new PilotageWatch(server(west).app as never);
    w.check(index, far, 3, 15);
    await flush();
    expect(w.check(index, far, 3, 15)).toBeUndefined();
  });

  describe("as a service", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-pilotage-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("notifies by the live fix, keeps its σ, clears off the route and on stop", async () => {
      const { app, sent } = server(west);
      const store = new FixHistoryStore(path.join(dir, "fix-history.json"));
      const opts = { ...DEFAULT_LOOKAHEAD, positionBuffer: 15 };
      const s = new PilotageService(
        store,
        app as never,
        "underkeel",
        () => opts,
        () => undefined
      );
      const NOW = Date.parse("2026-11-22T12:00:00Z");
      const at = (p: LonLat, sigma: number, t: number, ok = true) =>
        s.tick({ integrity: fix(sigma, ok), index, position: { value: p, at: t }, now: t });
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
      expect(s.history.samples(NOW + 5000)).toBe(1);
      // A stale position takes no sample and no verdict.
      s.tick({
        integrity: fix(1),
        index,
        position: { value: ON_LINE, at: NOW },
        now: NOW + 60_000
      });
      expect(s.history.samples(NOW + 60_000)).toBe(1);
      s.stop(NOW + 61_000);
      expect(fs.existsSync(path.join(dir, "fix-history.json"))).toBe(true);
    });
  });
});
