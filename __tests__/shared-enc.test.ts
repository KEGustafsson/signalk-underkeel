import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import { scanCellSources } from "../src/ingest/cell-source";
import { readSource } from "../src/spatial/build-source";
import type { SharedAreaAnswer, SharedEncApi } from "../src/shared-enc";
import {
  ALL_COLLECTIONS,
  COLLECTION_CHOICE_PATTERN,
  collectionsHint,
  noteSharedCells,
  requestSharedArea,
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

  test("a configured collection is read in place of the cells directory", () => {
    const cfg = parseConfig({ cellsDir: "/charts", chartsProviderEnc: " Gulf_of_Finland " });
    expect(cfg.chartsProviderEnc).toBe("Gulf_of_Finland");
    const { api } = fakeProvider("/srv/enc-store");
    expect(withSharedCells(cfg, dataDir, api).cellsDir).toBe(
      path.join("/srv/enc-store", "Gulf_of_Finland")
    );
    expect(withSharedCells(parseConfig({ cellsDir: "/charts" }), dataDir, api).cellsDir).toBe(
      "/charts"
    );
    expect(parseConfig({ chartsProviderEnc: "../x" }).chartsProviderEnc).toBeUndefined();
    expect(parseConfig({ chartsProviderEnc: "*" }).chartsProviderEnc).toBe("*");
    // The admin form refuses what parsing would drop, so a mistyped name is not saved.
    const form = new RegExp(COLLECTION_CHOICE_PATTERN);
    for (const value of [" Gulf_of_Finland ", "*", "US5MA1AM", "Gulf of Finland", "../x", "a*"]) {
      expect(form.test(value)).toBe(
        parseConfig({ chartsProviderEnc: value }).chartsProviderEnc !== undefined
      );
    }
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
    // A cell two collections share is read once, from the first in name order.
    expect(all.sources.map((s) => path.relative(root, s).split(path.sep).join("/"))).toEqual([
      "Gulf_of_Finland/FI4SYNTH/FI4SYNTH.000",
      "Gulf_of_Finland/FI5SYNTH/FI5SYNTH.000"
    ]);
    expect(all.skipped).toEqual([path.join("Other", "FI5SYNTH", "FI5SYNTH.000")]);
  });

  test("the admin form names the collections shared now", () => {
    expect(collectionsHint(undefined)).toBeUndefined();
    expect(collectionsHint(fakeProvider("/r").api)).toBe(
      "Shared now: Gulf_of_Finland (chart set, 2 cells), US5MA1AM (converted chart, 1 cells)."
    );
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
    expect(requestSharedArea(bbox, failing)).toEqual({
      accepted: false,
      started: false,
      reason: "store gone"
    });
  });

  test("each box asks for its area only with the setting on and the source *", () => {
    const logged: string[] = [];
    const app = {
      error: (m: string) => logged.push(`error ${m}`),
      debug: (m: string) => logged.push(`debug ${m}`)
    } as unknown as Parameters<typeof areaRequests>[1];
    expect(
      areaRequests({ chartsProviderArea: true, chartsProviderEnc: "Gulf_of_Finland" }, app)
    ).toBeUndefined();
    expect(
      areaRequests({ chartsProviderArea: false, chartsProviderEnc: ALL_COLLECTIONS }, app)
    ).toBeUndefined();
    expect(areaRequests({ chartsProviderArea: true }, app)).toBeUndefined();
    const ask = areaRequests({ chartsProviderArea: true, chartsProviderEnc: ALL_COLLECTIONS }, app);
    expect(ask).toBeDefined();
    const { api } = fakeProvider("/r");
    let answer = { accepted: true, started: true, reason: "downloading the area" };
    (globalThis as { __signalk_chartsProviderEnc?: unknown }).__signalk_chartsProviderEnc = {
      ...api,
      requestArea: () => answer
    };
    ask?.([20, 59, 21, 60]);
    ask?.([20, 59, 21, 60]);
    answer = { accepted: false, started: false, reason: "turn it on" };
    ask?.([20, 59, 21, 60]);
    expect(logged).toEqual([
      "debug Charts Provider, asked for the ENC around the vessel: downloading the area",
      "error Charts Provider, asked for the ENC around the vessel: turn it on"
    ]);
  });

  test("a box is asked about again when Charts Provider says when, or is not running", () => {
    const app = { error: () => undefined, debug: () => undefined } as unknown as Parameters<
      typeof areaRequests
    >[1];
    const ask = areaRequests({ chartsProviderArea: true, chartsProviderEnc: ALL_COLLECTIONS }, app);
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
    // Kept between a minute and half an hour, whatever the provider says.
    answer = { ...answer, retryAfterMs: 5 };
    expect(ask?.([20, 59, 21, 60])).toBe(AREA_ASK_MIN_MS);
    answer = { ...answer, retryAfterMs: 24 * 3_600_000 };
    expect(ask?.([20, 59, 21, 60])).toBe(AREA_ASK_MAX_MS);
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

  test("the plugin builds from the collection and restarts when its cells change", async () => {
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
    const options = { chartsProviderEnc: "Gulf_of_Finland", boxRadiusKm: 0, leafZoom: 18 };
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
    expect(readSource(path.join(dataDir, "index"))).toBe("charts-provider:Gulf_of_Finland");
  });
});
