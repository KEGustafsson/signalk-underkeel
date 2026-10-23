import type { Delta } from "@signalk/server-api";
import { parseConfig } from "../src/config";
import { SLOW_TICK_MS } from "../src/escape-search";
import type { Clock } from "../src/monitor";
import { Monitor } from "../src/monitor";
import { KEEP_ALIVE_MS, ValuePublisher } from "../src/tick-publisher";
import { NOTIFY_REFRESH_MS } from "../src/engine/notify";
import { BUILDING_REASON, LOADING_REASON, WFS_WAITING_REASON } from "../src/index-loader";
import type { ChartIndex } from "../src/spatial/chart-index";
import { fixtureIndex, M_PER_DEG_LON, ROCK } from "./helpers/fixture-index";
import { navDelta, T0, values } from "./helpers/plugin-harness";

/**
 * What a tick publishes: values on change with a keep-alive, the status on
 * change, the look-ahead notification at once on a state or reason change
 * and its countdown at most every NOTIFY_REFRESH_MS, and the escape search
 * after the tick, skipped after a slow one.
 */

const NOTIFICATION = "notifications.navigation.underKeel";

interface Rig {
  monitor: Monitor;
  deltas: Partial<Delta>[];
  statuses: string[];
  errors: string[];
  /** Advances the clock by a second and ticks. */
  tick(nav?: Delta): void;
  /** Deferred callbacks, run by `flush`. */
  deferred: (() => void)[];
  flush(): void;
  /** Milliseconds each vessel lookup takes, to make a tick slow. */
  lookupMs: number;
}

/** `index` null starts the monitor without one. */
function rig(defer: boolean, index: ChartIndex | null = fixtureIndex(), reason?: string): Rig {
  let now = T0;
  const deltas: Partial<Delta>[] = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  const deferred: (() => void)[] = [];
  const r = { lookupMs: 0 } as Rig;
  const app = {
    handleMessage: (_id: string, d: Partial<Delta>) => deltas.push(d),
    setPluginStatus: (m: string) => statuses.push(m),
    setPluginError: (m: string) => errors.push(m),
    error: () => undefined,
    subscriptionmanager: { subscribe: () => undefined },
    getSelfPath: (p: string) => {
      now += r.lookupMs;
      return p === "design.draft" ? { value: { maximum: 3.2 } } : undefined;
    }
  };
  const clock: Clock = {
    now: () => now,
    setInterval: () => 1,
    clearInterval: () => undefined,
    ...(defer
      ? {
          defer: (fn: () => void) => deferred.push(fn) && fn,
          cancel: (fn: unknown) => deferred.splice(deferred.indexOf(fn as () => void), 1)
        }
      : {})
  };
  const config = parseConfig({ waterLevel: { source: "manual", height: 0 } });
  const monitor = new Monitor(
    app as never,
    "signalk-underkeel",
    config,
    index ?? undefined,
    reason,
    clock
  );
  monitor.start();
  return Object.assign(r, {
    monitor,
    deltas,
    statuses,
    errors,
    deferred,
    tick(nav?: Delta) {
      now += 1000;
      if (nav) {
        monitor.onDelta(nav);
      }
      monitor.tick();
    },
    flush() {
      deferred.splice(0).forEach((fn) => fn());
    }
  });
}

const sent = (deltas: Partial<Delta>[], path: string) =>
  values(deltas).filter((v) => v.path === path).length;

/** Heading east at 3 m/s, `seconds` of travel west of the rock, at `at`. */
const approach = (seconds: number, at: number) =>
  navDelta(ROCK[0] - (3 * seconds) / M_PER_DEG_LON, ROCK[1], 3, at);

describe("tick publishing", () => {
  test("unchanged values wait for the keep-alive; state and envelope rev go every tick", () => {
    const r = rig(false);
    const still = navDelta(22.003, 60.0125, 0, T0);
    r.deltas.length = 0;
    const ticks = KEEP_ALIVE_MS / 1000 + 5;
    for (let i = 0; i < ticks; i++) {
      r.tick({ ...still, updates: still.updates.map((u) => ({ ...u, timestamp: undefined })) });
    }
    expect(sent(r.deltas, "navigation.underKeel.state")).toBe(ticks);
    expect(sent(r.deltas, "navigation.underKeel.envelopeRev")).toBe(ticks);
    // Once when it first changes, then at the keep-alive; the level was sent at start.
    expect(sent(r.deltas, "navigation.underKeel.clearance")).toBe(2);
    expect(sent(r.deltas, "navigation.underKeel.waterLevel")).toBe(1);
  });

  test("each value's keep-alive counts from when that value was last sent", () => {
    const out: Partial<Delta>[] = [];
    const p = new ValuePublisher({ handleMessage: (_id, d) => out.push(d) }, "p", new Set());
    p.send(
      [
        { path: "a", value: 1 },
        { path: "b", value: 1 }
      ],
      0
    );
    p.send([{ path: "a", value: 2 }], 5_000);
    p.send(
      [
        { path: "a", value: 2 },
        { path: "b", value: 1 }
      ],
      KEEP_ALIVE_MS
    );
    expect(values(out).map((v) => v.path)).toEqual(["a", "b", "a", "b"]);
  });

  test("a changed value is sent on the tick it changes", () => {
    const r = rig(false);
    r.tick(approach(170, T0 + 1000));
    r.deltas.length = 0;
    // Three seconds closer: time to shoal moves one 3 s step.
    r.tick(approach(167, T0 + 2000));
    expect(sent(r.deltas, "navigation.underKeel.timeToShoal")).toBe(1);
  });

  test("the plugin status is set only when its text changes", () => {
    const r = rig(false);
    const still = () => {
      const d = navDelta(22.003, 60.0125, 0, 0);
      return { ...d, updates: d.updates.map((u) => ({ ...u, timestamp: undefined })) };
    };
    for (let i = 0; i < 5; i++) {
      r.tick(still());
    }
    expect(r.statuses.filter((s) => s === r.statuses.at(-1))).toHaveLength(1);
    r.tick(approach(40, T0 + 6000));
    r.tick(approach(39, T0 + 7000));
    expect(r.statuses.at(-1)).toMatch(/^Monitoring: (warn|alarm)/);
  });

  test("the countdown is refreshed at most every 30 s; a new state goes out at once", () => {
    const r = rig(false);
    // From 140 s out the rock is a warn whose countdown drops every tick.
    let t = 140;
    r.tick(approach(t, T0 + 1000));
    r.tick(approach(--t, T0 + 2000));
    const states = () =>
      values(r.deltas)
        .filter((v) => v.path === NOTIFICATION)
        .map((v) => (v.value as { state: string }).state);
    const before = states().length;
    const warnTicks = 25;
    for (let i = 0; i < warnTicks; i++) {
      r.tick(approach(--t, T0 + 3000 + i * 1000));
    }
    expect(r.monitor.last.state).toBe("warn");
    expect(states().length - before).toBeLessThanOrEqual(
      Math.ceil((warnTicks * 1000) / NOTIFY_REFRESH_MS)
    );
    // Close in until alarm is published: its notification goes out on that same tick.
    for (let i = 0; i < 60 && r.monitor.last.state !== "alarm"; i++) {
      r.tick(approach(--t, T0 + 30_000 + i * 1000));
    }
    expect(r.monitor.last.state).toBe("alarm");
    expect(states().at(-1)).toBe("alarm");
  });
});

describe("escape search after the tick", () => {
  test("runs once the tick's result is out and publishes its heading", () => {
    const r = rig(true);
    r.tick(approach(40, T0 + 1000));
    r.tick(approach(39, T0 + 2000));
    expect(r.monitor.last.state).toBe("alarm");
    expect(r.deferred.length).toBe(1);
    r.deltas.length = 0;
    r.flush();
    const heading = values(r.deltas).find((v) => v.path === "navigation.underKeel.escapeHeading");
    expect(heading?.value).toEqual(expect.any(Number));
  });

  test("a tick slower than the limit skips the search and says so in the status", () => {
    const r = rig(true);
    r.tick(approach(40, T0 + 1000));
    r.flush();
    r.lookupMs = SLOW_TICK_MS;
    r.tick(approach(39, T0 + 2000));
    r.flush();
    r.tick(approach(38, T0 + 3000));
    expect(r.deferred.length).toBe(0);
    expect(r.statuses.at(-1)).toMatch(/escape search skipped: a tick took \d+ ms/);
    r.lookupMs = 0;
    r.tick(approach(37, T0 + 5000));
    r.tick(approach(36, T0 + 6000));
    expect(r.statuses.at(-1)).not.toMatch(/skipped/);
  });

  test("a tick that turns normal publishes no heading, nor does the slow tick that clears it", () => {
    const r = rig(true);
    r.tick(approach(40, T0 + 1000));
    r.tick(approach(39, T0 + 2000));
    r.flush();
    const heading = () =>
      values(r.deltas)
        .filter((v) => v.path === "navigation.underKeel.escapeHeading")
        .at(-1)?.value;
    expect(heading()).toEqual(expect.any(Number));
    // Clear of the rock: the heading goes on the tick the held alarm lifts, not a tick later.
    const clear = (at: number) => navDelta(ROCK[0] - 1000 / M_PER_DEG_LON, ROCK[1] + 0.01, 0, at);
    for (let i = 0; i < 30 && r.monitor.last.state !== "normal"; i++) {
      r.tick(clear(T0 + 3000 + i * 1000));
    }
    expect(r.monitor.last.state).toBe("normal");
    expect(r.monitor.last.escapeHeading).toBeNull();
    expect(heading()).toBeNull();
    r.tick(approach(40, T0 + 10_000));
    r.tick(approach(39, T0 + 11_000));
    r.flush();
    expect(heading()).toEqual(expect.any(Number));
    r.lookupMs = SLOW_TICK_MS;
    r.tick(approach(38, T0 + 12_000));
    expect(heading()).toBeNull();
  });

  test("a tick at low speed publishes no heading, even while the alarm is held", () => {
    const r = rig(true);
    r.tick(approach(40, T0 + 1000));
    r.tick(approach(39, T0 + 2000));
    r.flush();
    const heading = () =>
      values(r.deltas)
        .filter((v) => v.path === "navigation.underKeel.escapeHeading")
        .at(-1)?.value;
    expect(heading()).toEqual(expect.any(Number));
    // Stopped short of the rock: still in danger, but there is no course to turn from.
    r.tick(navDelta(ROCK[0] - 30 / M_PER_DEG_LON, ROCK[1], 0, T0 + 3000));
    expect(r.monitor.last.state).toBe("alarm");
    expect(r.monitor.last.escapeHeading).toBeNull();
    expect(heading()).toBeNull();
    expect(r.deferred.length).toBe(0);
  });

  test("stop cancels a pending search", () => {
    const r = rig(true);
    r.tick(approach(40, T0 + 1000));
    r.tick(approach(39, T0 + 2000));
    expect(r.deferred.length).toBe(1);
    r.monitor.stop();
    r.deltas.length = 0;
    r.flush();
    expect(sent(r.deltas, "navigation.underKeel.escapeHeading")).toBe(0);
  });
});

describe("index status", () => {
  test.each([BUILDING_REASON, LOADING_REASON, WFS_WAITING_REASON])(
    "%s is a status, not a server error, while the engine stays off",
    (reason) => {
      const r = rig(false, null, reason);
      r.tick();
      expect(r.monitor.last).toMatchObject({ state: "off", reason });
      expect(r.statuses.at(-1)).toBe(reason);
      expect(r.errors).toEqual([]);
    }
  );

  test("a failed index load is a server error", () => {
    const r = rig(false, null, "chart index failed: disk gone");
    r.tick();
    expect(r.monitor.last.state).toBe("off");
    expect(r.errors).toEqual(["chart index failed: disk gone"]);
    expect(r.statuses).toEqual([]);
  });

  test("notes about a loaded index go in the status beside the monitoring state", () => {
    const r = rig(false, fixtureIndex(), "skipped X.000 in cells: not a cell directory");
    r.tick(navDelta(22.003, 60.0125, 0, T0 + 1000));
    expect(r.statuses.at(-1)).toMatch(/^Monitoring: .* · skipped X\.000/);
    expect(r.errors).toEqual([]);
  });

  test("an index handed over after the build clears the building status", () => {
    const r = rig(false, null, BUILDING_REASON);
    r.tick();
    r.monitor.setIndex(fixtureIndex());
    r.tick(navDelta(22.003, 60.0125, 0, T0 + 2000));
    expect(r.statuses.at(-1)).toMatch(/^Monitoring: /);
    expect(r.errors).toEqual([]);
  });
});
