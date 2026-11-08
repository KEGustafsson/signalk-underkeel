import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import { cellVersionRank, scanCellSources } from "../src/ingest/cell-source";
import { baseEdition } from "../src/ingest/enc-wasm";
import { readSource } from "../src/spatial/build-source";
import type { SharedAreaAnswer, SharedEncApi } from "../src/shared-enc";
import {
  ALL_COLLECTIONS,
  AREA_ERROR_RETRY_MS,
  CHARTS_PROVIDER_ID,
  collectionsHint,
  noteSharedCells,
  requestSharedArea,
  runningProviders,
  sharedCellsDir,
  sharedCellsNote,
  sharedEncApi,
  sharedEncRoot,
  watchSharedCells,
  withSharedCells
} from "../src/shared-enc";
import underkeel = require("../src/index");
import { AREA_ASK_MAX_MS, AREA_ASK_MIN_MS, areaRequests } from "../src/wfs-wiring";
import { CELLS, inlineBuilder } from "./helpers/fixture-index";
import { fakeApp, fakeClock, T0 } from "./helpers/plugin-harness";

/**
 * The ENC cells signalk-charts-provider-simple shares: which directory a
 * collection is read from, and how a change to its cells reaches the index.
 */

/** A fake charts provider API over `root`, whose `emit` tells the listeners of a change. */
function fakeProvider(root: string) {
  const listeners = new Set<(id: string) => void>();
  const api: SharedEncApi = {
    apiVersion: 1,
    root,
    collections: () => [
      { id: "Gulf_of_Finland", name: "Gulf of Finland", kind: "chart-set", cellCount: 2 },
      { id: "US5MA1AM", name: "US5MA1AM", kind: "conversion", cellCount: 1 }
    ],
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return { api, listeners, emit: (id: string) => [...listeners].forEach((l) => l(id)) };
}

/** A store at `root` laid out as the charts provider writes it, with the fixture cells. */
function writeStore(root: string): void {
  for (const [collection, cell] of [
    ["Gulf_of_Finland", "FI4SYNTH"],
    ["Gulf_of_Finland", "FI5SYNTH"],
    ["Other", "FI5SYNTH"]
  ] as const) {
    const dir = path.join(root, collection, cell);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(CELLS, `${cell}.000`), path.join(dir, `${cell}.000`));
    fs.writeFileSync(path.join(root, collection, "collection.json"), "{}");
  }
  // Work in progress, which a reader skips.
  fs.mkdirSync(path.join(root, ".staging-Other-1-1", "FI9WORK0"), { recursive: true });
  fs.writeFileSync(path.join(root, ".staging-Other-1-1", "FI9WORK0", "FI9WORK0.000"), "");
}

describe("charts provider ENC store", () => {
  let tmp: string;
  let dataDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-shared-"));
    dataDir = path.join(tmp, "plugin-config-data", "signalk-underkeel");
    fs.mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => {
    delete (globalThis as { __signalk_chartsProviderEnc?: unknown }).__signalk_chartsProviderEnc;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("is found through the provider's API, else beside this plugin's data", () => {
    const fallback = path.join(
      tmp,
      "plugin-config-data",
      "signalk-charts-provider-simple",
      "enc-store"
    );
    expect(sharedEncApi()).toBeUndefined();
    expect(sharedEncRoot(dataDir)).toBe(fallback);
    expect(sharedCellsDir(dataDir, "Gulf_of_Finland")).toBe(path.join(fallback, "Gulf_of_Finland"));
    expect(sharedCellsDir(dataDir, ALL_COLLECTIONS)).toBe(fallback);

    const { api } = fakeProvider("/srv/enc-store");
    (globalThis as { __signalk_chartsProviderEnc?: unknown }).__signalk_chartsProviderEnc = api;
    expect(sharedEncApi()).toBe(api);
    expect(sharedCellsDir(dataDir, "Gulf_of_Finland")).toBe(
      path.join("/srv/enc-store", "Gulf_of_Finland")
    );
    expect(
      sharedEncApi({ __signalk_chartsProviderEnc: { ...api, apiVersion: 2 } })
    ).toBeUndefined();
    expect(sharedEncApi({ __signalk_chartsProviderEnc: "x" })).toBeUndefined();
  });

  test("choosing Charts Provider reads every cell it shares, and nothing else is read", () => {
    const cfg = parseConfig({ chartsProvider: CHARTS_PROVIDER_ID });
    expect(cfg.chartsProviderEnc).toBe(ALL_COLLECTIONS);
    const { api } = fakeProvider("/srv/enc-store");
    expect(withSharedCells(cfg, dataDir, api).cellsDir).toBe("/srv/enc-store");
    // A cells directory, or a collection, is no setting of its own: no ENC is read without
    // a chosen provider.
    const own = parseConfig({ cellsDir: "/charts", chartsProviderEnc: "Gulf_of_Finland" });
    expect(own.cellsDir).toBeUndefined();
    expect(own.chartsProviderEnc).toBeUndefined();
    expect(withSharedCells(own, dataDir, api).cellsDir).toBeUndefined();
    expect(parseConfig({ chartsProvider: "another-provider" }).chartsProviderEnc).toBeUndefined();
  });

  test("the cell scan finds a collection's cells, and every collection's in the store", () => {
    const root = path.join(tmp, "enc-store");
    writeStore(root);
    const names = (dir: string) =>
      scanCellSources(dir).sources.map((s) => path.relative(root, s).split(path.sep).join("/"));
    expect(names(path.join(root, "Gulf_of_Finland"))).toEqual([
      "Gulf_of_Finland/FI4SYNTH/FI4SYNTH.000",
      "Gulf_of_Finland/FI5SYNTH/FI5SYNTH.000"
    ]);
    const all = scanCellSources(root);
    // A cell two collections share in the same version is read once, from the first in name order.
    expect(all.sources.map((s) => path.relative(root, s).split(path.sep).join("/"))).toEqual([
      "Gulf_of_Finland/FI4SYNTH/FI4SYNTH.000",
      "Gulf_of_Finland/FI5SYNTH/FI5SYNTH.000"
    ]);
    expect(all.skipped).toEqual([path.join("Other", "FI5SYNTH", "FI5SYNTH.000")]);
  });

  test("of a cell two collections share, the newest edition and update is read", () => {
    const root = path.join(tmp, "enc-store");
    const put = (collection: string, cell: string, from: string, updates = 0) => {
      const dir = path.join(root, collection, cell);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(CELLS, `${from}.000`), path.join(dir, `${cell}.000`));
      for (let u = 1; u <= updates; u++) {
        fs.writeFileSync(path.join(dir, `${cell}.${String(u).padStart(3, "0")}`), "");
      }
    };
    const read = () => {
      const scan = scanCellSources(root);
      const rel = (s: string) => path.relative(root, s).split(path.sep).join("/");
      const slash = (s: string) => s.split(path.sep).join("/");
      return { sources: scan.sources.map(rel), skipped: scan.skipped.map(slash) };
    };
    // FI5SYNTH is edition 3, FI4SYNTH edition 7: a copy of the latter under the former's name
    // is a newer edition, here in the collection later in name order.
    put("A_set", "FI5SYNTH", "FI5SYNTH");
    put("B_set", "FI5SYNTH", "FI4SYNTH");
    expect(read()).toEqual({
      sources: ["B_set/FI5SYNTH/FI5SYNTH.000"],
      skipped: ["A_set/FI5SYNTH/FI5SYNTH.000"]
    });
    // The same edition: the copy with the later update.
    fs.rmSync(root, { recursive: true });
    put("A_set", "FI4SYNTH", "FI4SYNTH", 1);
    put("B_set", "FI4SYNTH", "FI4SYNTH", 2);
    put("C_set", "FI4SYNTH", "FI4SYNTH");
    expect(read()).toEqual({
      sources: ["B_set/FI4SYNTH/FI4SYNTH.000"],
      skipped: ["A_set/FI4SYNTH/FI4SYNTH.000", "C_set/FI4SYNTH/FI4SYNTH.000"]
    });
    // A copy whose edition cannot be read ranks below one whose edition can, either way round.
    fs.rmSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "A_set", "FI4SYNTH"), { recursive: true });
    fs.writeFileSync(path.join(root, "A_set", "FI4SYNTH", "FI4SYNTH.000"), "not S-57");
    put("B_set", "FI4SYNTH", "FI4SYNTH");
    expect(read().sources).toEqual(["B_set/FI4SYNTH/FI4SYNTH.000"]);
    fs.mkdirSync(path.join(root, "C_set", "FI4SYNTH"), { recursive: true });
    fs.writeFileSync(path.join(root, "C_set", "FI4SYNTH", "FI4SYNTH.000"), "not S-57");
    expect(read().sources).toEqual(["B_set/FI4SYNTH/FI4SYNTH.000"]);
  });

  test("a copy's version counts its base cell's update and only the updates that follow on", () => {
    const dir = path.join(tmp, "cells");
    fs.mkdirSync(dir);
    const cell = (name: string, updn?: number | string, updates: number[] = []) => {
      const file = path.join(dir, name, "FI4SYNTH.000");
      fs.mkdirSync(path.dirname(file));
      const bytes = fs.readFileSync(path.join(CELLS, "FI4SYNTH.000"));
      if (updn !== undefined) {
        // EDTN 7 then UPDN 0 in the DSID, each ended by 0x1f: re-issued with `updn` applied.
        const at = bytes.indexOf(Buffer.from([0x1f, 0x37, 0x1f, 0x30, 0x1f]));
        expect(at).toBeGreaterThan(0);
        bytes[at + 3] = typeof updn === "number" ? 0x30 + updn : updn.charCodeAt(0);
      }
      fs.writeFileSync(file, bytes);
      for (const u of updates) {
        fs.writeFileSync(file.replace(/000$/, String(u).padStart(3, "0")), "");
      }
      return file;
    };
    expect(cellVersionRank(cell("plain"))).toBe(700_000);
    // A re-issue carrying update 3 outranks a copy with updates 1 and 2 beside it.
    expect(cellVersionRank(cell("reissued", 3))).toBe(700_003);
    expect(cellVersionRank(cell("two", undefined, [1, 2]))).toBe(700_002);
    // Updates up to the base cell's are in it already; the next one follows on.
    expect(cellVersionRank(cell("reissued-on", 3, [2, 3, 4]))).toBe(700_004);
    // An update after a gap does not apply, nor do those after it.
    expect(cellVersionRank(cell("gap", undefined, [1, 3, 4]))).toBe(700_001);
    // A UPDN that is not a number leaves the version unknown, not update 0: such a copy ranks
    // below every copy whose version is known, as the charts provider ranks it.
    expect(cellVersionRank(cell("malformed", "x", [1, 2]))).toBe(-1);
    // Nor when its separator is gone, so UPDN runs on into the digits after it, or when it
    // ends in a newline: neither may read as a known update.
    const patched = (name: string, edit: (bytes: Buffer, at: number) => Buffer) => {
      const file = cell(name);
      const bytes = fs.readFileSync(file);
      const at = bytes.indexOf(Buffer.from([0x1f, 0x37, 0x1f, 0x30, 0x1f]));
      expect(at).toBeGreaterThan(0);
      fs.writeFileSync(file, edit(bytes, at));
      return file;
    };
    const runOn = patched("run-on", (bytes, at) => {
      bytes[at + 4] = 0x30;
      return bytes;
    });
    expect(cellVersionRank(runOn)).toBe(-1);
    const newline = patched("newline", (bytes, at) => {
      bytes[at + 3] = 0x31;
      return Buffer.concat([
        bytes.subarray(0, at + 4),
        Buffer.from([0x0a]),
        bytes.subarray(at + 4)
      ]);
    });
    expect(cellVersionRank(newline)).toBe(-1);
    // The edition reads still, as the update count of a cell read with GDAL needs it.
    expect(baseEdition(newline)).toBe(7);
    // A file that cannot be read ranks below every copy that can.
    expect(cellVersionRank(path.join(dir, "gone", "FI4SYNTH.000"))).toBe(-1);
  });

  test("the admin form names the collections shared now", () => {
    expect(collectionsHint(undefined)).toBeUndefined();
    expect(collectionsHint(fakeProvider("/r").api)).toBe(
      "Shared now: Gulf_of_Finland (chart set, 2 cells), US5MA1AM (converted chart, 1 cells)."
    );
    expect(runningProviders({})).toEqual({ running: [] });
    expect(runningProviders({ __signalk_chartsProviderEnc: fakeProvider("/r").api })).toEqual({
      running: [CHARTS_PROVIDER_ID],
      shared:
        "Shared now: Gulf_of_Finland (chart set, 2 cells), US5MA1AM (converted chart, 1 cells)."
    });
  });

  test("says why the collection in use has no cells, as the provider tells it", () => {
    const { api } = fakeProvider("/r");
    const states: Record<string, { state: string; detail?: string }> = {
      Gulf_of_Finland: { state: "ready" },
      Writing: { state: "writing" },
      Fetching: { state: "pending", detail: "downloading" },
      Waiting: { state: "pending", detail: "not downloaded yet" }
    };
    const told = { ...api, state: (id: string) => states[id] ?? { state: "absent" } };
    expect(sharedCellsNote("Gulf_of_Finland", told)).toBeUndefined();
    expect(sharedCellsNote("Writing", told)).toMatch(/is writing the cells of Writing/);
    expect(sharedCellsNote("Fetching", told)).toMatch(/is downloading Fetching/);
    expect(sharedCellsNote("Waiting", told)).toMatch(/not downloaded yet: download it/);
    expect(sharedCellsNote("Nope", told)).toMatch(/shares no Nope/);
    // An older provider cannot tell; nor can one that is not running.
    expect(sharedCellsNote("Nope", api)).toBeUndefined();
    expect(sharedCellsNote("Nope", undefined)).toBeUndefined();
    expect(sharedCellsNote(ALL_COLLECTIONS, { ...told, collections: () => [] })).toMatch(
      /shares no ENC cells yet/
    );
    expect(sharedCellsNote(ALL_COLLECTIONS, told)).toBeUndefined();

    const reason = "no cells in /r/Waiting";
    expect(noteSharedCells({ reason }, { chartsProviderEnc: "Waiting" }, told).reason).toBe(
      `${reason}; Waiting is a Charts Provider chart set not downloaded yet: download it in its ENC Charts tab`
    );
    // Nothing amiss, or another source: unchanged.
    expect(noteSharedCells({}, { chartsProviderEnc: "Waiting" }, told)).toEqual({});
    expect(noteSharedCells({ reason }, {}, told)).toEqual({ reason });
  });

  test("asks the provider for an area, when it can be asked", () => {
    const { api } = fakeProvider("/r");
    const asked: unknown[] = [];
    const answer = { accepted: true, started: true, reason: "downloading the area" };
    const bbox = [20, 59, 21, 60] as const;
    expect(requestSharedArea(bbox, api)).toBeUndefined();
    expect(
      requestSharedArea(bbox, {
        ...api,
        requestArea: (b, requester) => {
          asked.push([b, requester]);
          return answer;
        }
      })
    ).toBe(answer);
    expect(asked).toEqual([[bbox, "signalk-underkeel"]]);
    const failing = {
      ...api,
      requestArea: () => {
        throw new Error("store gone");
      }
    };
    // A failure, unlike a refusal, is asked about again: the provider may recover.
    expect(requestSharedArea(bbox, failing)).toEqual({
      accepted: false,
      started: false,
      reason: "store gone",
      retryAfterMs: AREA_ERROR_RETRY_MS
    });
  });

  test("each box asks the chosen provider for its area, and the answer is kept for the status", () => {
    const logged: string[] = [];
    const app = {
      error: (m: string) => logged.push(`error ${m}`),
      debug: (m: string) => logged.push(`debug ${m}`)
    } as unknown as Parameters<typeof areaRequests>[1];
    expect(areaRequests({}, app)).toBeUndefined();
    const area = areaRequests({ chartsProviderEnc: ALL_COLLECTIONS }, app);
    expect(area?.note()).toBeUndefined();
    const { api } = fakeProvider("/r");
    const scope = globalThis as { __signalk_chartsProviderEnc?: unknown };
    const box: [number, number, number, number] = [20, 59, 21, 60];
    let answer: SharedAreaAnswer = {
      accepted: true,
      started: true,
      reason: "downloading the area"
    };
    scope.__signalk_chartsProviderEnc = { ...api, requestArea: () => answer };
    area?.ask(box);
    area?.ask(box);
    expect(area?.note()).toBe("Charts Provider is downloading the ENC around the vessel");
    // A provider without cellsIn cannot say whether it has cells there: its reason is the note.
    answer = { accepted: false, started: false, reason: "turn it on" };
    area?.ask(box);
    expect(area?.note()).toBe("Charts Provider: turn it on");

    // With cellsIn, asked once a box: whether any stored cell reaches the area.
    let cells: { collection: string; cell: string; base: string }[] = [];
    const asked: unknown[] = [];
    scope.__signalk_chartsProviderEnc = {
      ...api,
      requestArea: () => answer,
      cellsIn: (b: unknown) => {
        asked.push(b);
        return cells;
      }
    };
    area?.ask(box);
    expect(area?.note()).toBe(
      "Charts Provider has no ENC for this area and does not download it: turn it on"
    );
    answer = { accepted: true, started: false, reason: "no free ENC covers the area" };
    area?.ask(box);
    expect(area?.note()).toBe(
      "Charts Provider has no ENC for this area: no free ENC covers the area"
    );
    cells = [{ collection: "Gulf_of_Finland", cell: "FI4SYNTH", base: "/r/FI4SYNTH.000" }];
    area?.ask(box);
    expect(area?.note()).toBeUndefined();
    expect(asked).toEqual([box, box, box]);
    scope.__signalk_chartsProviderEnc = {
      ...api,
      requestArea: () => answer,
      cellsIn: () => {
        throw new TypeError("bbox must be [west, south, east, north] in degrees");
      }
    };
    area?.ask(box);
    expect(area?.note()).toBe("Charts Provider: no free ENC covers the area");

    scope.__signalk_chartsProviderEnc = api;
    area?.ask(box);
    expect(area?.note()).toBe(
      "Charts Provider is too old to be asked for the ENC around the vessel: update it"
    );
    delete scope.__signalk_chartsProviderEnc;
    area?.ask(box);
    expect(area?.note()).toBe("Charts Provider is not running");
    expect(logged).toEqual([
      "debug Charts Provider, asked for the ENC around the vessel: downloading the area",
      "error Charts Provider, asked for the ENC around the vessel: turn it on",
      "debug Charts Provider, asked for the ENC around the vessel: no free ENC covers the area",
      "error Charts Provider is too old to be asked for the ENC around the vessel: update it",
      "error Charts Provider is not running"
    ]);
  });

  test("a box is asked about again when Charts Provider says when, or is not running", () => {
    const app = { error: () => undefined, debug: () => undefined } as unknown as Parameters<
      typeof areaRequests
    >[1];
    const ask = areaRequests({ chartsProviderEnc: ALL_COLLECTIONS }, app)?.ask;
    const scope = globalThis as { __signalk_chartsProviderEnc?: unknown };
    delete scope.__signalk_chartsProviderEnc;
    expect(ask?.([20, 59, 21, 60])).toBe(5 * 60_000);
    const { api } = fakeProvider("/r");
    let answer: SharedAreaAnswer = {
      accepted: true,
      started: true,
      reason: "downloading the area"
    };
    scope.__signalk_chartsProviderEnc = { ...api, requestArea: () => answer };
    expect(ask?.([20, 59, 21, 60])).toBeUndefined();
    answer = { accepted: true, started: false, reason: "index loading", retryAfterMs: 90_000 };
    expect(ask?.([20, 59, 21, 60])).toBe(90_000);
    answer = { ...answer, retryAfterMs: 5 };
    expect(ask?.([20, 59, 21, 60])).toBe(AREA_ASK_MIN_MS);
    answer = { ...answer, retryAfterMs: 24 * 3_600_000 };
    expect(ask?.([20, 59, 21, 60])).toBe(AREA_ASK_MAX_MS);
    // A refusal on purpose waits for the area to change; a failure is asked about again.
    answer = { accepted: false, started: false, reason: "turned off" };
    expect(ask?.([20, 59, 21, 60])).toBeUndefined();
    scope.__signalk_chartsProviderEnc = {
      ...api,
      requestArea: () => {
        throw new Error("store gone");
      }
    };
    expect(ask?.([20, 59, 21, 60])).toBe(AREA_ERROR_RETRY_MS);
    delete scope.__signalk_chartsProviderEnc;
  });

  test("a change to the collection in use is acted on once it settles", () => {
    const clock = fakeClock(T0);
    const provider = fakeProvider("/r");
    let changes = 0;
    const watch = watchSharedCells("Gulf_of_Finland", clock, () => changes++, {
      scope: { __signalk_chartsProviderEnc: provider.api },
      settleMs: 5000,
      pollMs: 1000
    });
    provider.emit("US5MA1AM");
    clock.advance(10_000);
    expect(changes).toBe(0);
    provider.emit("Gulf_of_Finland");
    clock.advance(3000);
    provider.emit("Gulf_of_Finland");
    clock.advance(3000);
    expect(changes).toBe(0);
    clock.advance(3000);
    expect(changes).toBe(1);
    clock.advance(30_000);
    expect(changes).toBe(1);
    watch.stop();
    expect(provider.listeners.size).toBe(0);
  });

  test("looks for the provider until it starts, less often after a while", () => {
    const clock = fakeClock(T0);
    const provider = fakeProvider("/r");
    const scope: { __signalk_chartsProviderEnc?: unknown } = {};
    let changes = 0;
    const watch = watchSharedCells(ALL_COLLECTIONS, clock, () => changes++, {
      scope,
      waitMs: 60_000,
      pollMs: 5000,
      settleMs: 0
    });
    clock.advance(10_000);
    scope.__signalk_chartsProviderEnc = provider.api;
    clock.advance(5000);
    expect(provider.listeners.size).toBe(1);
    // Starting late counts as a change, and so does what it reports after.
    expect(changes).toBe(1);
    provider.emit("Any");
    clock.advance(5000);
    expect(changes).toBe(2);
    watch.stop();

    const late = fakeProvider("/r");
    const empty: { __signalk_chartsProviderEnc?: unknown } = {};
    const periods: number[] = [];
    const timed = {
      ...clock,
      setInterval: (f: () => void, ms: number) => {
        periods.push(ms);
        return clock.setInterval(f, ms);
      }
    };
    const slow = watchSharedCells(ALL_COLLECTIONS, timed, () => changes++, {
      scope: empty,
      waitMs: 60_000,
      pollMs: 5000,
      slowPollMs: 60_000,
      settleMs: 0
    });
    clock.advance(30_000);
    expect(periods).toEqual([5000]);
    clock.advance(35_000);
    expect(periods).toEqual([5000, 60_000]);
    clock.advance(600_000);
    expect(late.listeners.size).toBe(0);
    empty.__signalk_chartsProviderEnc = late.api;
    clock.advance(60_000);
    expect(late.listeners.size).toBe(1);
    expect(changes).toBe(3);
    slow.stop();
    expect(late.listeners.size).toBe(0);
  });

  test("a provider that starts later counts as a change, one there at start does not", () => {
    // It may have written cells before this plugin could hear of them, or keep its store
    // away from the default path read at start; the restart rebuilds only on a difference.
    const clock = fakeClock(T0);
    const provider = fakeProvider("/srv/enc-store");
    const scope: { __signalk_chartsProviderEnc?: unknown } = {};
    let changes = 0;
    const late = watchSharedCells("Gulf_of_Finland", clock, () => changes++, {
      scope,
      pollMs: 1000,
      settleMs: 2000
    });
    scope.__signalk_chartsProviderEnc = provider.api;
    clock.advance(1000);
    expect(provider.listeners.size).toBe(1);
    clock.advance(1000);
    expect(changes).toBe(0);
    clock.advance(1000);
    expect(changes).toBe(1);
    late.stop();

    const present = watchSharedCells("Gulf_of_Finland", clock, () => changes++, {
      scope,
      pollMs: 1000,
      settleMs: 0
    });
    clock.advance(10_000);
    expect(changes).toBe(1);
    present.stop();
  });

  test("the plugin builds from every shared cell and restarts when they change", async () => {
    const root = path.join(tmp, "enc-store");
    writeStore(root);
    const provider = fakeProvider(root);
    (globalThis as { __signalk_chartsProviderEnc?: unknown }).__signalk_chartsProviderEnc =
      provider.api;
    const f = fakeApp(dataDir, { "design.draft": { value: { maximum: 3.2 } } });
    const clock = fakeClock(T0);
    const dirs: string[][] = [];
    const build = inlineBuilder;
    const builds: Promise<unknown>[] = [];
    const plugin = underkeel(f.app, clock, globalThis.fetch, (job, signal) => {
      dirs.push(job.dirs.map((d) => path.relative(root, d).split(path.sep).join("/")));
      const built = build(job, signal);
      builds.push(built);
      return built;
    });
    const options = { chartsProvider: CHARTS_PROVIDER_ID, boxRadiusKm: 0, leafZoom: 18 };
    const restarts: object[] = [];
    plugin.start(options, (config) => restarts.push(config));
    expect(dirs).toEqual([
      ["Gulf_of_Finland/FI4SYNTH/FI4SYNTH.000", "Gulf_of_Finland/FI5SYNTH/FI5SYNTH.000"]
    ]);
    provider.emit("Gulf_of_Finland");
    clock.advance(5000);
    clock.advance(5000);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatchObject(options);
    plugin.stop();
    expect(provider.listeners.size).toBe(0);
    await Promise.all(builds);
    expect(readSource(path.join(dataDir, "index"))).toBe("charts-provider:*");
  });
});
