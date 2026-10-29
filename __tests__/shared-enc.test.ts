import fs from "fs";
import os from "os";
import path from "path";
import { parseConfig } from "../src/config";
import { scanCellSources } from "../src/ingest/cell-source";
import type { SharedEncApi } from "../src/shared-enc";
import {
  ALL_COLLECTIONS,
  collectionsHint,
  sharedCellsDir,
  sharedEncApi,
  sharedEncRoot,
  watchSharedCells,
  withSharedCells
} from "../src/shared-enc";
import underkeel = require("../src/index");
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
    // A name that is not a collection id is no choice.
    expect(parseConfig({ chartsProviderEnc: "../x" }).chartsProviderEnc).toBeUndefined();
    expect(parseConfig({ chartsProviderEnc: "*" }).chartsProviderEnc).toBe("*");
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

  test("waits for the provider to start, for a while", () => {
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

    // Never started: it stops looking.
    const late = fakeProvider("/r");
    const empty: { __signalk_chartsProviderEnc?: unknown } = {};
    watchSharedCells(ALL_COLLECTIONS, clock, () => changes++, { scope: empty, waitMs: 60_000 });
    clock.advance(65_000);
    clock.advance(5_000);
    empty.__signalk_chartsProviderEnc = late.api;
    clock.advance(5_000);
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
    const plugin = underkeel(f.app, clock, globalThis.fetch, (job, signal) => {
      dirs.push(job.dirs.map((d) => path.relative(root, d).split(path.sep).join("/")));
      return build(job, signal);
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
    await new Promise((r) => setImmediate(r));
  });
});
