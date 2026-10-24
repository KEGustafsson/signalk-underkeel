import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "../src/api-wiring";
import { parseConfig } from "../src/config";
import { createStatus } from "../src/foundation/state";
import { RequestQueue } from "../src/route-service";
import { schemaHints, setupChecks, setupFacts } from "../src/setup-checks";

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

const meanWater = [{ verdat: 3, known: true, cells: ["FI1", "FI2"], series: "mw", sigma: 0.1 }];

describe("setup check", () => {
  test("nothing set: charts and draft are to do, the engine is not started", () => {
    const s = state({});
    expect(setupChecks(s, setupFacts(app(), s))).toEqual([
      { id: "charts", level: "todo", text: "Charts: set the ENC cells directory" },
      { id: "draft", level: "todo", text: "Draft: not set here or in design.draft.maximum" },
      { id: "waterLevel", level: "ok", text: "Water level: none" },
      { id: "lookahead", level: "warn", text: "Look-ahead: plugin not started" }
    ]);
  });

  test("a cells directory without an index names why, without the server path", () => {
    const s = state({ cellsDir: "/c" }, undefined, 0, "cannot read /srv/charts/x");
    expect(setupChecks(s, setupFacts(app(), s))[0]?.level).toBe("warn");
    expect(setupChecks(s, setupFacts(app(), s))[0]?.text).not.toMatch(/\/srv\/charts/);
  });

  test("own draft, an index, mean-water charts without a source and a running engine", () => {
    const s = state({ cellsDir: "/c", vessel: { draft: 1.8 } }, monitor(undefined, meanWater), 2);
    const facts = setupFacts(app(), s);
    expect(facts.datums).toEqual([{ verdat: 3, cells: 2, lowWater: false, fmi: true }]);
    expect(setupChecks(s, facts)).toEqual([
      { id: "charts", level: "ok", text: "Charts: 2 cells indexed" },
      { id: "draft", level: "ok", text: "Draft 1.8 m" },
      { id: "waterLevel", level: "todo", text: "Water level: choose fmi" },
      { id: "lookahead", level: "ok", text: "Look-ahead: normal" }
    ]);
  });

  test("a degraded level is a warning with its reason", () => {
    const s = state({ waterLevel: { source: "fmi" } }, monitor("FMI forecast stale"));
    expect(setupChecks(s, setupFacts(app(), s))[2]).toEqual({
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
        s
      )
    ).toEqual({
      signalk: { draft: 2.1, length: 11.5, beam: 3.8 },
      depthPaths: ["belowSurface"],
      tide: true,
      cells: 0,
      datums: []
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
