import type { Delta } from "@signalk/server-api";
import { parseConfig } from "../src/config";
import type { Clock } from "../src/monitor";
import { Monitor } from "../src/monitor";
import { KEEP_ALIVE_MS } from "../src/tick-publisher";
import { NOTIFY_REFRESH_MS } from "../src/engine/notify";
import { fixtureIndex, M_PER_DEG_LON, ROCK } from "./helpers/fixture-index";
import { navDelta, T0, values } from "./helpers/plugin-harness";

/**
 * What a tick publishes: values on change with a keep-alive, the status on
 * change, and the look-ahead notification at once on a state or reason
 * change and its countdown at most every NOTIFY_REFRESH_MS.
 */

const NOTIFICATION = "notifications.navigation.underKeel";

interface Rig {
  monitor: Monitor;
  deltas: Partial<Delta>[];
  statuses: string[];
  /** Advances the clock by a second and ticks. */
  tick(nav?: Delta): void;
  /** Deferred callbacks, run by `flush`. */
  deferred: (() => void)[];
  flush(): void;
  /** Milliseconds each vessel lookup takes, to make a tick slow. */
  lookupMs: number;
}

function rig(defer: boolean): Rig {
  let now = T0;
  const deltas: Partial<Delta>[] = [];
  const statuses: string[] = [];
  const deferred: (() => void)[] = [];
  const r = { lookupMs: 0 } as Rig;
  const app = {
    handleMessage: (_id: string, d: Partial<Delta>) => deltas.push(d),
    setPluginStatus: (m: string) => statuses.push(m),
    setPluginError: () => undefined,
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
    fixtureIndex(),
    undefined,
    clock
  );
  monitor.start();
  return Object.assign(r, {
    monitor,
    deltas,
    statuses,
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
