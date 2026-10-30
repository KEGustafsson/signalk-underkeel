import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "../src/api-wiring";
import { parseConfig } from "../src/config";
import { createStatus } from "../src/foundation/state";
import { RequestQueue } from "../src/route-service";
import type { HostFacts } from "../src/setup-checks";
import {
  LOW_AVAILABLE,
  schemaHints,
  setupChecks,
  setupFacts,
  SMALL_MEMORY
} from "../src/setup-checks";

/** What the setup check reports for each state of charts, draft, water level and engine. */

type Monitorish = {
  last: { state: string; reason: string };
  waterLevelStatus(): { applied: { degraded?: string }; datums: unknown[] };
};

function state(raw: unknown, monitor?: Monitorish, cells = 0, reason?: string): PluginState {
  return {
    zoneErrors: [],
    stopped: createStatus("off", "plugin not started", new Date(0)),
    requests: new RequestQueue(),
    config: parseConfig(raw),
    monitor: monitor as never,
    load: {
      indexDir: "/x",
      built: false,
      reason,
      index: cells ? ({ catalogue: { cells: new Array(cells).fill({}) } } as never) : undefined
    }
  };
}

const app = (self: Record<string, unknown> = {}) =>
  ({ getSelfPath: (p: string) => self[p] }) as unknown as Pick<ServerAPI, "getSelfPath">;

const monitor = (degraded?: string, datums: unknown[] = []): Monitorish => ({
  last: { state: "normal", reason: "" },
  waterLevelStatus: () => ({ applied: { degraded }, datums })
});

const GIB = 2 ** 30;
/** A 2 GB machine with room to spare: no advice. */
const HOST: HostFacts = { memory: 2 * GIB, available: GIB, cpus: 4 };
const HARDWARE = { id: "hardware", level: "ok", text: "Hardware: 4 CPUs, 2.0 GB RAM, 1.0 GB free" };

const meanWater = [{ verdat: 3, known: true, cells: ["FI1", "FI2"], series: "mw", sigma: 0.1 }];

describe("setup check", () => {
  test("nothing set: charts and draft are to do, the engine is not started", () => {
    const s = state({});
    expect(setupChecks(s, setupFacts(app(), s, HOST))).toEqual([
      {
        id: "charts",
        level: "todo",
        text: "Charts: set the ENC cells directory or ENC from Charts Provider"
      },
      { id: "draft", level: "todo", text: "Draft: not set here or in design.draft.maximum" },
      { id: "waterLevel", level: "ok", text: "Water level: none" },
      { id: "lookahead", level: "warn", text: "Look-ahead: plugin not started" },
      HARDWARE
    ]);
  });

  test("a cells directory without an index names why, without the server path", () => {
    const s = state({ cellsDir: "/c" }, undefined, 0, "cannot read /srv/charts/x");
    expect(setupChecks(s, setupFacts(app(), s, HOST))[0]?.level).toBe("warn");
    expect(setupChecks(s, setupFacts(app(), s, HOST))[0]?.text).not.toMatch(/\/srv\/charts/);
  });

  test("own draft, an index, mean-water charts without a source and a running engine", () => {
    const s = state({ cellsDir: "/c", vessel: { draft: 1.8 } }, monitor(undefined, meanWater), 2);
    const facts = setupFacts(app(), s, HOST);
    expect(facts.datums).toEqual([{ verdat: 3, cells: 2, lowWater: false, fmi: true }]);
    expect(setupChecks(s, facts)).toEqual([
      { id: "charts", level: "ok", text: "Charts: 2 cells indexed" },
      { id: "draft", level: "ok", text: "Draft 1.8 m" },
      { id: "waterLevel", level: "todo", text: "Water level: choose fmi" },
      { id: "lookahead", level: "ok", text: "Look-ahead: normal" },
      HARDWARE
    ]);
  });

  test("a degraded level is a warning with its reason", () => {
    const s = state({ waterLevel: { source: "fmi" } }, monitor("FMI forecast stale"));
    expect(setupChecks(s, setupFacts(app(), s, HOST))[2]).toEqual({
      id: "waterLevel",
      level: "warn",
      text: "Water level: FMI forecast stale"
    });
  });

  test("facts come from Signal K design, depth and tide paths", () => {
    const s = state({});
    expect(
      setupFacts(
        app({
          "design.draft": { value: { maximum: 2.1 } },
          "design.length": { value: { overall: 11.5 } },
          "design.beam": { value: 3.8 },
          "environment.depth.belowSurface": { value: 6.4 },
          "environment.tide.heightNow": { value: 0.2 }
        }),
        s,
        HOST
      )
    ).toEqual({
      signalk: { draft: 2.1, length: 11.5, beam: 3.8 },
      depthPaths: ["belowSurface"],
      tide: true,
      cells: 0,
      datums: [],
      host: HOST
    });
  });

  test("schema hints carry the marks, the Signal K draft and the datum sentence", () => {
    const s = state({}, monitor(undefined, meanWater));
    const hints = schemaHints(app({ "design.draft": { value: { maximum: 2.1 } } }), s);
    expect(hints.checks?.[1]).toBe("✓ Draft 2.1 m from design.draft.maximum");
    expect(hints.signalkDraft).toBe(2.1);
    expect(hints.source).toBe(
      "Your charts are not on low water (VERDAT 3 in 2 cells): choose fmi in Finnish waters."
    );
  });
});

describe("hardware advice", () => {
  const hardware = (raw: unknown, host: HostFacts) => {
    const s = state(raw);
    return setupChecks(s, setupFacts(app(), s, host)).find((c) => c.id === "hardware");
  };
  /** A Raspberry Pi 3 or Cerbo GX: 1 GB, of which the kernel reports about 0.9. */
  const pi3: HostFacts = { memory: 0.9 * GIB, available: 0.5 * GIB, cpus: 4 };
  const big: HostFacts = { memory: 8 * GIB, available: 6 * GIB, cpus: 8 };

  test("on 1 GB, box 0 and leaf zoom 20 are advised against", () => {
    const c = hardware({ cellsDir: "/c", boxRadiusKm: 0, leafZoom: 20 }, pi3);
    expect(c?.level).toBe("warn");
    expect(c?.text).toMatch(/^Hardware: 4 CPUs, 0\.9 GB RAM, 0\.5 GB free\. /);
    expect(c?.text).toMatch(
      /Index box 0 indexes every cell.*set Index box around the vessel to 10 km/
    );
    expect(c?.text).toMatch(/consider Index leaf zoom 19/);
  });

  test("on 1 GB with a box and leaf zoom 19 there is nothing to advise", () => {
    expect(hardware({ cellsDir: "/c", boxRadiusKm: 10, leafZoom: 19 }, pi3)?.level).toBe("ok");
    // With the WFS on its own radius sets the box, so box 0 is not the whole set.
    const wfs = hardware({ boxRadiusKm: 0, leafZoom: 19, wfs: { enabled: true } }, pi3);
    expect(wfs?.text).not.toMatch(/Index box 0/);
  });

  test("the 1 GB advice stops above the small-memory line", () => {
    const at = (memory: number) =>
      hardware({ cellsDir: "/c", boxRadiusKm: 0, leafZoom: 20 }, { ...pi3, memory })?.level;
    expect(at(SMALL_MEMORY)).toBe("warn");
    expect(at(SMALL_MEMORY + 1)).toBe("ok");
  });

  test("with plenty of RAM and a box, box 0 is suggested to avoid rebuilds", () => {
    const c = hardware({ cellsDir: "/c", boxRadiusKm: 10 }, big);
    expect(c?.level).toBe("ok");
    expect(c?.text).toMatch(/Index box 0 indexes it once and avoids rebuilds/);
    expect(hardware({ cellsDir: "/c", boxRadiusKm: 0 }, big)?.text).toBe(
      "Hardware: 8 CPUs, 8.0 GB RAM, 6.0 GB free"
    );
  });

  test("little free memory is a warning whatever the RAM", () => {
    const c = hardware({ cellsDir: "/c" }, { ...big, available: LOW_AVAILABLE - 2 ** 20 });
    expect(c?.level).toBe("warn");
    expect(c?.text).toMatch(/only 255 MB free: a chart index build may run out of memory/);
  });

  test("the advice changes no setting", () => {
    const raw = { cellsDir: "/c", boxRadiusKm: 0, leafZoom: 20 };
    const s = state(raw);
    const before = JSON.stringify(s.config);
    setupChecks(s, setupFacts(app(), s, pi3));
    schemaHints(app(), s);
    expect(JSON.stringify(s.config)).toBe(before);
  });

  test("the facts read this machine when none are given", () => {
    const { host } = setupFacts(app(), state({}));
    expect(host.memory).toBeGreaterThan(0);
    expect(host.available).toBeLessThanOrEqual(host.memory);
    expect(host.cpus).toBeGreaterThanOrEqual(1);
  });
});
