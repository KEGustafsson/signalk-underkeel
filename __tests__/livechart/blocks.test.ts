import fs from "fs";
import os from "os";
import path from "path";
import type { LonLat } from "../../src/foundation/geo";
import { tileAt, toMercator } from "../../src/foundation/geo";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import type { CellPosterior } from "../../src/livechart/posterior";
import { chartPrior } from "../../src/livechart/posterior";
import { cacheOf, RETRY_MS } from "../../src/spatial/block-cache";
import type { BlockReader } from "../../src/spatial/block-reader";
import type { NodeStore } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { pyramidFromBuffer, serializePyramid } from "../../src/spatial/store";
import { basin, point } from "../helpers/synthetic";

/**
 * The living chart on an index read block by block (plan §4.13): a chart prior is read only
 * from a loaded block, never from the stand-ins a query reads while it loads, so a cell is
 * judged against its own charted depth after a start, a rebind or a first sounding.
 */

const T0 = 1_800_000_000_000;
const CONFIG: LivechartConfig = {
  source: { path: "environment.depth.belowSurface", transducerDepth: 0, forward: 0, starboard: 0 },
  writeNotes: false,
  csb: { id: "anon", idType: "Other" }
};
const SHOAL: LonLat = [22.0505, 60.0505];
/** A 2 m rock in the shoal cell's z15 tile but not in its z18 cell. */
const ROCK: LonLat = [22.0535, 60.0505];

/** The fixture chart held whole in memory. */
const chart = (): NodeStore =>
  buildPyramid([...basin([22.0, 60.0, 22.1, 60.1], 10), point(...ROCK, 2)], {
    minZoom: 12,
    leafZoom: 18
  });
const whole = chart();
const file = serializePyramid(whole, { residentZoom: 15, blockZoom: 13 });

/** The index read block by block, nothing loaded, every block read off the event loop. */
const cold = (): NodeStore => pyramidFromBuffer(file, { budgetBytes: Infinity, syncBytes: -1 });

const away = () => buildPyramid(basin([23.0, 61.0, 23.1, 61.1], 10), { minZoom: 12, leafZoom: 18 });

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function service(store: NodeStore, file = path.join(tmp(), "livechart.json")) {
  return new LivechartService(store, CONFIG, file, {
    setNote: () => Promise.resolve(),
    error: (m) => {
      throw new Error(m);
    },
    now: () => T0
  });
}

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-lc-blocks-"));
  dirs.push(dir);
  return dir;
}

/** `n` soundings of `depth` at `position`, in two passes 15 minutes apart from `start`. */
function sound(
  svc: LivechartService,
  depth: number,
  n: number,
  position: LonLat = SHOAL,
  start = T0
): void {
  for (let k = 0; k < n; k++) {
    const at = start + (k < n / 2 ? 0 : 15 * 60_000) + k * 1000;
    svc.onSounding({
      depth,
      at,
      position,
      positionAt: at,
      hdop: 0.9,
      methodQuality: "GNSS Fix",
      waterLevel: { h: 0, sigma: 0.05, source: "manual" }
    });
  }
}

const shoalDepth = (store: NodeStore) => minDepthOver(store, footprintGeom([SHOAL])).dMin;

const cellsOf = (svc: LivechartService): CellPosterior[] => [
  ...(
    svc as unknown as { posteriors: { cells: Map<number, CellPosterior> } }
  ).posteriors.cells.values()
];

describe("living chart on an index read block by block", () => {
  test("the fixture's stand-in prior for the shoal cell is the rock's depth", () => {
    const [mx, my] = toMercator(...SHOAL);
    const [rx, ry] = toMercator(...ROCK);
    expect(tileAt(15, rx, ry)).toEqual(tileAt(15, mx, my));
    expect(tileAt(18, rx, ry)).not.toEqual(tileAt(18, mx, my));
    const { x, y } = tileAt(18, mx, my);
    expect(chartPrior(whole, 18, x, y).depth).toBe(10);
    expect(chartPrior(cold(), 18, x, y).depth).toBe(2);
  });

  test("a cell first sounded before its block loads is judged against the loaded chart", async () => {
    const store = cold();
    const svc = service(store);
    sound(svc, 6, 6);
    expect(svc.status()).toMatchObject({ unsettled: 1, discrepancies: 0 });
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 0, discrepancies: 1 });
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10 });
    expect(shoalDepth(store)).toBeLessThan(7);
  });

  test("a cell over a block refused for good stays unsettled, never judged on stand-ins", async () => {
    const store = cold();
    const cache = cacheOf(store);
    const [mx, my] = toMercator(...SHOAL);
    const { x, y } = tileAt(cache?.blockZoom ?? 13, mx, my);
    const key = x * 2 ** (cache?.blockZoom ?? 13) + y;
    cache?.failed.set(key, "pyramid file is corrupt");
    const svc = service(store);
    sound(svc, 6, 6);
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 1, discrepancies: 0 });
  });

  test("cells restored at start wait for their block, then are judged against it", async () => {
    // Four soundings: not yet a discrepancy, and saved so.
    const saved = path.join(tmp(), "livechart.json");
    const first = service(whole, saved);
    sound(first, 6, 4);
    first.save();

    const store = cold();
    const svc = service(store, saved);
    expect(cacheOf(store)?.count).toBe(0);
    expect(svc.status()).toMatchObject({ unsettled: 1 });
    // A fifth sounding before the block loads is not judged against a stand-in.
    sound(svc, 6, 1);
    await svc.whenSettled();
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10, samples: 5 });
    expect(shoalDepth(store)).toBeLessThan(7);
  });

  test("a rebind prepared onto an index read block by block waits for the blocks", async () => {
    // Uncharted at first: no prior to be shallower than.
    const svc = service(away());
    sound(svc, 6, 6);
    expect(svc.discrepancies()).toEqual([]);
    const store = cold();
    const apply = await svc.prepareRebind(
      store,
      () => true,
      () => new Promise((r) => setImmediate(r))
    );
    apply();
    expect(svc.status()).toMatchObject({ unsettled: 0 });
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10 });
    expect(shoalDepth(store)).toBeLessThan(7);
  });

  test("a rebind done at once leaves the cell unsettled until its block loads", async () => {
    const svc = service(away());
    sound(svc, 6, 6);
    const store = cold();
    svc.rebind(store);
    expect(svc.discrepancies()).toEqual([]);
    expect(svc.status()).toMatchObject({ unsettled: 1 });
    await svc.whenSettled();
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10 });
  });

  test("a stopped service settles nothing more", async () => {
    const store = cold();
    const svc = service(store);
    sound(svc, 6, 6);
    svc.stop();
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 1, discrepancies: 0 });
  });

  test("cells whose blocks are dropped during a settle run are each judged against the chart", async () => {
    const saved = path.join(tmp(), "livechart.json");
    const first = service(whole, saved);
    // Four soundings in each of six cells, in z13 blocks of their own.
    const spots: LonLat[] = [22.01, 22.06, 22.09].flatMap((lon) => [
      [lon, 60.01],
      [lon, 60.08]
    ]);
    for (const p of spots) {
      sound(first, 9, 4, p);
    }
    first.save();
    // Every block over budget: each is dropped once the next one loads.
    const store = pyramidFromBuffer(file, { budgetBytes: 1, syncBytes: -1 });
    const svc = service(store, saved);
    expect(svc.status()).toMatchObject({ cells: 6, unsettled: 6 });
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 0 });
    const cache = cacheOf(store);
    expect(cache?.loads).toBeGreaterThanOrEqual(3);
    expect(cache?.count).toBeLessThanOrEqual(1);
    for (const c of cellsOf(svc)) {
      expect(c.chartDepth).toBe(10);
    }
  });

  test("a block that fails to read for a while leaves its cell unsettled until a retry reads it", async () => {
    const saved = path.join(tmp(), "livechart.json");
    const first = service(whole, saved);
    sound(first, 6, 4);
    first.save();
    const store = cold();
    // The first read is refused as busy, as a passing EBUSY or EMFILE would be.
    const reader = (cacheOf(store) as unknown as { reader: BlockReader }).reader;
    const read = reader.read.bind(reader);
    let refused = 0;
    reader.read = (offset, bytes) =>
      refused++ === 0
        ? Promise.reject(Object.assign(new Error("resource busy"), { code: "EBUSY" }))
        : read(offset, bytes);
    const svc = service(store, saved);
    await svc.whenSettled();
    // Not settled against the stand-ins, whose prior is the 2 m rock.
    expect(svc.status()).toMatchObject({ unsettled: 1 });
    expect(cellsOf(svc)[0]?.chartDepth).toBeNaN();
    const now = Date.now();
    const later = jest.spyOn(Date, "now").mockReturnValue(now + RETRY_MS + 1000);
    try {
      svc.flush();
      await svc.whenSettled();
    } finally {
      later.mockRestore();
    }
    expect(svc.status()).toMatchObject({ unsettled: 0 });
    expect(cellsOf(svc)[0]?.chartDepth).toBe(10);
    sound(svc, 6, 1);
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10, samples: 5 });
  });

  test("a cell sounded between a prepared rebind and its apply waits for its block", async () => {
    const svc = service(away());
    sound(svc, 6, 6);
    // The block is read for the rebind and dropped again before the apply.
    const store = pyramidFromBuffer(file, { budgetBytes: 1, syncBytes: -1 });
    const apply = await svc.prepareRebind(
      store,
      () => true,
      () => new Promise((r) => setImmediate(r))
    );
    expect(cacheOf(store)?.count).toBe(0);
    sound(svc, 6, 1);
    apply();
    expect(svc.status()).toMatchObject({ unsettled: 1, discrepancies: 0 });
    await svc.whenSettled();
    expect(svc.status()).toMatchObject({ unsettled: 0 });
    expect(svc.discrepancies()[0]).toMatchObject({ charted: 10, samples: 7 });
    expect(shoalDepth(store)).toBeLessThan(7);
  });
});

describe("notes and discrepancies of a cell waiting for its block", () => {
  const CHARTED: unknown = expect.stringMatching(/^Suspected shoal [\d.]+ m \(charted 10 m\)$/);
  const depthIn = (name?: string) => Number(/shoal ([\d.]+) m/.exec(name ?? "")?.[1]);

  /** A service writing notes on its own clock, confirmed over the shoal on the whole chart. */
  function confirmed(file = path.join(tmp(), "livechart.json")) {
    const t = { now: T0 };
    const notes: string[] = [];
    const deps = {
      setNote: (_id: string, body: Record<string, unknown>) => {
        notes.push(String(body.name));
        return Promise.resolve();
      },
      error: (m: string) => {
        throw new Error(m);
      },
      now: () => t.now
    };
    const store = chart();
    const svc = new LivechartService(store, { ...CONFIG, writeNotes: true }, file, deps);
    sound(svc, 6, 6);
    expect(notes).toEqual([CHARTED]);
    // A shallower reading moves the note a step; it waits for its 5 minutes.
    t.now = T0 + 60_000;
    sound(svc, 4, 1, SHOAL, T0 + 16 * 60_000);
    expect(notes).toHaveLength(1);
    return { t, notes, svc, deps, file, store };
  }

  test("a stop before the cell's block loads writes no 'not charted' note", () => {
    const h = confirmed();
    const was = [...h.store.adjustments.values()][0]?.cellRef;
    const store = cold();
    h.svc.rebind(store);
    // Waiting, not uncharted; its adjustment names no cell rather than the last index's.
    expect(h.svc.discrepancies()[0]).toMatchObject({ charted: null, pending: true });
    expect([...store.adjustments.values()][0]?.cellRef).toBe(-1);
    expect(was).toBeGreaterThanOrEqual(0);
    h.svc.stop();
    expect(h.notes).toHaveLength(1);
  });

  test("a note waiting for the block is written with the chart's depth once it is read", async () => {
    const h = confirmed();
    h.svc.rebind(cold());
    h.t.now += 5 * 60_000;
    h.svc.flush();
    expect(h.notes).toHaveLength(1);
    await h.svc.whenSettled();
    h.svc.flush();
    expect(h.svc.discrepancies()[0]).toMatchObject({ charted: 10 });
    expect(h.svc.discrepancies()[0]?.pending).toBeUndefined();
    expect(h.notes).toEqual([CHARTED, CHARTED]);
    expect(depthIn(h.notes[1])).toBeLessThan(depthIn(h.notes[0]));
  });

  test("a note a stop left waiting is written after the next start reads the chart", async () => {
    const h = confirmed();
    h.svc.rebind(cold());
    h.svc.stop();
    expect(h.notes).toHaveLength(1);
    const notes: string[] = [];
    const again = new LivechartService(cold(), { ...CONFIG, writeNotes: true }, h.file, {
      ...h.deps,
      setNote: (_id, body) => {
        notes.push(String(body.name));
        return Promise.resolve();
      }
    });
    expect(again.discrepancies()[0]).toMatchObject({ pending: true });
    await again.whenSettled();
    expect(notes).toEqual([CHARTED]);
    expect(depthIn(notes[0])).toBeLessThan(depthIn(h.notes[0]));
  });
});
