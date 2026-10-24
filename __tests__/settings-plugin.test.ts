import fs from "fs";
import os from "os";
import path from "path";
import underkeel = require("../src/index");
import { V1_BACKUP } from "../src/settings-service";
import { suggestedSource } from "../src/setup-checks";
import { CELLS, prepareFixtureIndex, seedFixtureIndex } from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, T0 } from "./helpers/plugin-harness";

beforeAll(prepareFixtureIndex);

/** The plugin's configuration surfaces: migration at start, the admin form and the setup panel's routes. */

type Settings = {
  values: Record<string, unknown>;
  facts: { signalk: { draft?: number }; cells: number; depthPaths: string[] };
  checks: { id: string; level: string; text: string }[];
};

describe("settings in the running plugin", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-settings-plugin-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const started = (options: Record<string, unknown>, self: Record<string, unknown> = {}) => {
    const f = fakeApp(dataDir, {
      "design.draft": { value: { maximum: 2.0 } },
      "environment.depth.belowTransducer": { value: 4.2 },
      ...self
    });
    const plugin = underkeel(f.app, fakeClock(T0));
    const r = fakeRouter();
    plugin.registerWithRouter?.(r.router as never);
    seedFixtureIndex(dataDir);
    const restarts: object[] = [];
    plugin.start(options, (c) => restarts.push(c));
    return { f, plugin, r, restarts };
  };

  test("a version 1 configuration is saved migrated, with a backup, and started with", () => {
    const v1 = {
      cellsDir: CELLS,
      boxRadiusKm: 0,
      leafZoom: 18,
      lookahead: { warnRisk: 0.05, kp: 2 }
    };
    const { f, r, plugin } = started(v1);
    try {
      expect(f.savedOptions).toEqual([
        { cellsDir: CELLS, boxRadiusKm: 0, leafZoom: 18, lookahead: { kp: 2 }, configVersion: 2 }
      ]);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, V1_BACKUP), "utf8"))).toEqual(v1);
      const s = r.call("/v1/settings").body as Settings;
      expect(s.values).toEqual(f.savedOptions[0]);
    } finally {
      plugin.stop();
    }
  });

  test("GET /settings reports what the plugin sees and what is left to set", () => {
    const { r, plugin } = started({
      configVersion: 2,
      cellsDir: CELLS,
      boxRadiusKm: 0,
      leafZoom: 18
    });
    try {
      const s = r.call("/v1/settings").body as Settings;
      expect(s.facts).toMatchObject({
        signalk: { draft: 2.0 },
        cells: 2,
        depthPaths: ["belowTransducer"]
      });
      expect(s.checks.map((c) => c.id)).toEqual(["charts", "draft", "waterLevel", "lookahead"]);
      expect(s.checks[1]).toEqual({
        id: "draft",
        level: "ok",
        text: "Draft 2 m from design.draft.maximum"
      });
    } finally {
      plugin.stop();
    }
  });

  test("POST /settings restarts the plugin through the server with the patched configuration", async () => {
    const { r, plugin, restarts } = started({ configVersion: 2, cellsDir: CELLS, leafZoom: 18 });
    try {
      const reply = await r.post("/v1/settings", {
        warningStyle: "early",
        vessel: { margin: 0.2 }
      });
      expect(reply.code).toBe(202);
      await new Promise((resolve) => setImmediate(resolve));
      expect(restarts).toEqual([
        {
          configVersion: 2,
          cellsDir: CELLS,
          leafZoom: 18,
          warningStyle: "early",
          vessel: { margin: 0.2 }
        }
      ]);
    } finally {
      plugin.stop();
    }
  });

  test("the admin form is flat on an unknown server and conditional from Signal K 2.32", () => {
    const { f, plugin } = started({
      configVersion: 2,
      cellsDir: CELLS,
      boxRadiusKm: 0,
      leafZoom: 18
    });
    try {
      const schema = () =>
        (plugin.schema as () => { properties: Record<string, unknown>; description: string })();
      expect(Object.keys(schema().properties)).toContain("lookahead");
      (f.app as unknown as { config: { version: string } }).config = { version: "2.33.0" };
      const form = schema();
      expect(Object.keys(form.properties)).not.toContain("lookahead");
      expect(form.properties).toHaveProperty("showExpert");
      expect(form.description).toMatch(
        /Setup check: ✓ Charts: 2 cells indexed · ✓ Draft 2 m from design\.draft\.maximum/
      );
    } finally {
      plugin.stop();
    }
  });

  test("the admin form still loads, without checks, before the plugin starts", () => {
    const f = fakeApp(dataDir);
    const plugin = underkeel(f.app, fakeClock(T0));
    const s = (plugin.schema as () => { description: string })();
    expect(s.description).not.toMatch(/Setup check/);
  });
});

describe("suggested water-level source", () => {
  test("none for low-water charts, fmi for FMI-mapped mean water, else signalk-tide", () => {
    const d = (verdat: number, lowWater: boolean, fmi: boolean) => ({
      verdat,
      cells: 1,
      lowWater,
      fmi
    });
    expect(suggestedSource([d(12, true, false)])).toBeUndefined();
    expect(suggestedSource([d(12, true, false), d(3, false, true)])).toBe("fmi");
    expect(suggestedSource([d(16, false, false)])).toBe("signalk-tide");
    expect(suggestedSource([])).toBeUndefined();
  });
});
