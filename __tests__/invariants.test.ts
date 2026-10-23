import fs from "fs";
import os from "os";
import path from "path";
import type { ServerAPI } from "@signalk/server-api";
import underkeel = require("../src/index");
import {
  CELLS,
  M_PER_DEG_LON,
  prepareFixtureIndex,
  ROCK,
  seedFixtureIndex
} from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, navDelta, T0, values } from "./helpers/plugin-harness";

beforeAll(prepareFixtureIndex);

/**
 * Safety invariants 6 and 7 (AGENTS.md) over a whole look-ahead alarm, from
 * the approach to plugin stop: the plugin never touches a PUT, autopilot or
 * course API and never writes steering paths, and the look-ahead alarm
 * leaves notifications.grounding to the grounding detector.
 */

const ACTUATION = /put|autopilot|steer|course|destination|route|engage|target|tack|gybe|dodge/i;

function alarmPassage(dataDir: string, options: Record<string, unknown>) {
  const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
  const used = new Set<string>();
  const app = new Proxy(f.app, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        used.add(prop);
      }
      return Reflect.get(target, prop, receiver) as unknown;
    }
  }) as ServerAPI;
  const clock = fakeClock(T0);
  const plugin = underkeel(app, clock);
  const { router } = fakeRouter();
  plugin.registerWithRouter?.(router as never);
  seedFixtureIndex(dataDir);
  plugin.start({ cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18, ...options }, () => undefined);
  const states: unknown[] = [];
  // 75 m west of the rock at 3 m/s, for 20 s: the bow stays short of it.
  for (let t = 0; t <= 20; t++) {
    const at = T0 + t * 1000;
    const d = navDelta(ROCK[0] - (75 - 3 * t) / M_PER_DEG_LON, ROCK[1], 3, at);
    d.updates[0]?.values.push({ path: "environment.depth.belowSurface" as never, value: 6 });
    f.send(d);
    clock.advance(at + 1000 - clock.now());
    states.push(
      values(f.deltas)
        .filter((v) => v.path === "navigation.underKeel.state")
        .pop()
    );
  }
  plugin.stop();
  return { used: [...used], paths: values(f.deltas).map((v) => v.path as string), states };
}

describe("safety invariants over a look-ahead alarm", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-invariants-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  for (const [name, options] of [
    ["grounding detector off", {}],
    ["grounding detector on", { groundingDetector: { enabled: true } }]
  ] as const) {
    test(`${name}: no actuation, and notifications.grounding untouched`, () => {
      const run = alarmPassage(dataDir, options);
      expect(run.states).toContainEqual({ path: "navigation.underKeel.state", value: "alarm" });
      expect(run.paths).toContain("notifications.navigation.underKeel");
      // Invariant 6.
      expect(run.used.filter((p) => ACTUATION.test(p))).toEqual([]);
      expect(run.paths.filter((p) => /^(steering|autopilot)\./.test(p))).toEqual([]);
      // Invariant 7.
      expect(run.paths.filter((p) => p.startsWith("notifications.grounding"))).toEqual([]);
    });
  }
});
