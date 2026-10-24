import fs from "fs";
import os from "os";
import path from "path";
import type { ServerAPI } from "@signalk/server-api";
import type { ApiProvider } from "../src/api/routes";
import { registerRoutes } from "../src/api/routes";
import type { PluginState } from "../src/api-wiring";
import { migrateConfig } from "../src/config-migrate";
import {
  applyPatch,
  patchErrors,
  persistMigration,
  saveSettings,
  V1_BACKUP
} from "../src/settings-service";
import { SCHEMA } from "../src/config-schema";
import { RequestQueue } from "../src/route-service";
import { createStatus } from "../src/foundation/state";
import { fakeRouter } from "./helpers/plugin-harness";

/** The setup panel's save: a patch checked against the schema, then a restart. */

function state(options?: Record<string, unknown>, restart?: (c: object) => void): PluginState {
  return {
    zoneErrors: [],
    stopped: createStatus("off", "plugin not started", new Date(0)),
    requests: new RequestQueue(),
    options,
    restart
  };
}

describe("settings patch", () => {
  test("a patch of known fields with the right types passes", () => {
    expect(
      patchErrors(
        {
          cellsDir: "/charts",
          warningStyle: "early",
          vessel: { draft: 2.1, hull: "longKeel", margin: null },
          waterLevel: { source: "fmi" },
          livechart: { enabled: true, transducerDepth: 0.4 },
          mooringZones: ["home"]
        },
        SCHEMA
      )
    ).toEqual([]);
  });

  test("unknown fields, wrong types and values outside a choice are named", () => {
    expect(
      patchErrors(
        {
          colour: "red",
          vessel: { draft: "2", hull: "raft" },
          waterLevel: "fmi",
          warningStyle: "loud",
          wfs: { enabled: 1 }
        },
        SCHEMA
      )
    ).toEqual([
      "colour is not a setting",
      "vessel.draft must be a number",
      "vessel.hull must be one of none, finKeel, longKeel, planing, displacement",
      "waterLevel must be an object",
      "warningStyle must be one of early, balanced, late",
      "wfs.enabled must be a boolean"
    ]);
  });

  test("objects merge field by field, null removes a field, arrays are replaced", () => {
    const base = { vessel: { draft: 2, margin: 0.3 }, mooringZones: ["a", "b"], cellsDir: "/c" };
    expect(
      applyPatch(base, { vessel: { draft: null, hull: "planing" }, mooringZones: ["c"] })
    ).toEqual({ vessel: { margin: 0.3, hull: "planing" }, mooringZones: ["c"], cellsDir: "/c" });
    expect(base.vessel).toEqual({ draft: 2, margin: 0.3 });
  });
});

describe("saving settings", () => {
  const fail = (message: string) => {
    throw new Error(`unexpected log: ${message}`);
  };

  test("answers 202 and restarts with the patched configuration after the reply", () => {
    const restarts: object[] = [];
    const later: (() => void)[] = [];
    const s = state({ cellsDir: "/c", configVersion: 2, vessel: { draft: 2 } }, (c) =>
      restarts.push(c)
    );
    const reply = saveSettings({ vessel: { hull: "finKeel" } }, s, fail, (f) => later.push(f));
    expect(reply).toEqual({ status: 202, body: { restarting: true } });
    expect(restarts).toEqual([]);
    later.forEach((f) => f());
    expect(restarts).toEqual([
      { cellsDir: "/c", configVersion: 2, vessel: { draft: 2, hull: "finKeel" } }
    ]);
  });

  test("a bad patch is refused 400 and nothing restarts", () => {
    const restarts: object[] = [];
    const s = state({}, (c) => restarts.push(c));
    expect(saveSettings([], s, fail, (f) => f()).status).toBe(400);
    expect(saveSettings({ vessel: { draft: "deep" } }, s, fail, (f) => f())).toEqual({
      status: 400,
      body: { errors: ["vessel.draft must be a number"] }
    });
    expect(restarts).toEqual([]);
  });

  test("before start there is nothing to save to", () => {
    expect(saveSettings({}, state(), fail, (f) => f()).status).toBe(503);
  });

  // The restart runs after the reply, where a throw would be uncaught and stop the server.
  test("a restart that throws is logged, not thrown", () => {
    const logged: string[] = [];
    const s = state({}, () => {
      throw new Error("disk full");
    });
    expect(
      saveSettings(
        {},
        s,
        (m) => logged.push(m),
        (f) => f()
      ).status
    ).toBe(202);
    expect(logged).toEqual(["settings not saved, plugin not restarted: disk full"]);
  });
});

describe("settings routes", () => {
  const api = {
    settings: () => ({ status: 200, body: { values: {} } }),
    saveSettings: (body: unknown) => ({ status: 202, body })
  } as unknown as ApiProvider;

  // The configuration names server directories, and saving restarts the plugin.
  test("are registered admin-only, outside the readonly and readwrite scopes", () => {
    const { router, levels, call } = fakeRouter();
    registerRoutes(router as never, api);
    expect(levels.has("GET /v1/settings")).toBe(false);
    expect(levels.has("POST /v1/settings")).toBe(false);
    expect(call("/v1/settings").code).toBe(200);
  });

  test("saving needs a JSON body", async () => {
    const { router, post } = fakeRouter();
    registerRoutes(router as never, api);
    expect((await post("/v1/settings", {}, { "content-type": "text/plain" })).code).toBe(415);
    expect(await post("/v1/settings", { warningStyle: "late" })).toEqual({
      code: 202,
      body: { warningStyle: "late" }
    });
  });
});

describe("saving a migrated configuration", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-settings-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const fakeApp = () => {
    const saved: object[] = [];
    const errors: string[] = [];
    const app = {
      getDataDirPath: () => dataDir,
      savePluginOptions: (c: object, cb: (e: Error | null) => void) => {
        saved.push(c);
        cb(null);
      },
      error: (m: string) => errors.push(m)
    } as unknown as ServerAPI;
    return { app, saved, errors };
  };

  test("keeps the version 1 configuration once and saves the migrated one", () => {
    const { app, saved } = fakeApp();
    const v1 = { cellsDir: "/c", lookahead: { warnRisk: 0.05 } };
    persistMigration(app, v1, migrateConfig(v1));
    expect(saved).toEqual([{ cellsDir: "/c", lookahead: {}, configVersion: 2 }]);
    const backup = path.join(dataDir, V1_BACKUP);
    expect(JSON.parse(fs.readFileSync(backup, "utf8"))).toEqual(v1);
    persistMigration(app, { other: true }, migrateConfig({ other: true }));
    expect(JSON.parse(fs.readFileSync(backup, "utf8"))).toEqual(v1);
  });

  test("saves nothing for a current configuration", () => {
    const { app, saved } = fakeApp();
    persistMigration(app, { configVersion: 2 }, migrateConfig({ configVersion: 2 }));
    expect(saved).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, V1_BACKUP))).toBe(false);
  });

  test("does not save over the configuration when the backup cannot be written", () => {
    const { app, saved, errors } = fakeApp();
    fs.rmSync(dataDir, { recursive: true, force: true });
    persistMigration(app, {}, migrateConfig({}));
    expect(saved).toEqual([]);
    expect(errors[0]).toMatch(/configuration backup not written/);
    fs.mkdirSync(dataDir);
  });
});
