import { tileKey } from "../../src/foundation/geo";
import { UkcTileChanges } from "../../src/api/ukc-tile-changes";
import type { NodeStore, NodeValues } from "../../src/spatial/node-store";
import { AdjustmentMap } from "../../src/spatial/node-store";

function fakeStore(): NodeStore {
  return { adjustments: new AdjustmentMap(), adjustZoom: 18 } as unknown as NodeStore;
}

const cell = (dMin: number): NodeValues => ({
  dMin,
  sigmaD: 0.3,
  sigmaP: 0,
  flags: 0,
  cellRef: -1
});

describe("UKC tile change list", () => {
  test("a tile is listed once the threshold leaves the range it was served for", () => {
    const store = fakeStore();
    const list = new UkcTileChanges();
    const at = (threshold: number) => list.observe({ store, key: "k", threshold });
    at(2);
    list.serve(14, 1, 1, { lo: 1.9, hi: 2.05 });
    list.serve(14, 1, 2, { lo: 1.5, hi: 3 });
    list.serve(14, 1, 3, { lo: -Infinity, hi: Infinity });
    const start = list.since(undefined);
    expect(start).toMatchObject({ all: false, tiles: [] });
    at(2.05);
    expect(list.since(start)).toMatchObject({ all: false, tiles: [] });
    at(2.06);
    const after = list.since(start);
    expect(after).toMatchObject({ all: false, tiles: [[14, 1, 1]] });
    expect(list.since(after)).toMatchObject({ all: false, tiles: [] });
    // Served again at the new threshold: listed again only when that range is left.
    list.serve(14, 1, 1, { lo: 2.051, hi: 2.4 });
    at(1.2);
    expect(list.since(after).tiles).toEqual([
      [14, 1, 2],
      [14, 1, 1]
    ]);
    expect(list.since(start).tiles).toEqual([
      [14, 1, 2],
      [14, 1, 1]
    ]);
  });

  test("a tile served twice is listed when the threshold leaves either copy's range", () => {
    const store = fakeStore();
    const list = new UkcTileChanges();
    list.observe({ store, key: "k", threshold: 2 });
    list.serve(14, 1, 1, { lo: 1.9, hi: 2.05 });
    list.observe({ store, key: "k", threshold: 2.04 });
    list.serve(14, 1, 1, { lo: 2.0, hi: 2.1 });
    const start = list.since(undefined);
    list.observe({ store, key: "k", threshold: 2.06 });
    expect(list.since(start).tiles).toEqual([[14, 1, 1]]);
  });

  test("any other input or the index changing refreshes every tile", () => {
    const store = fakeStore();
    const list = new UkcTileChanges();
    list.observe({ store, key: "0.3|0.01|0.05|false", threshold: 2 });
    list.serve(14, 1, 1, { lo: 1, hi: 3 });
    const start = list.since(undefined);
    list.observe({ store, key: "0.3|0.01|0.05|true", threshold: 2 });
    expect(list.since(start)).toMatchObject({ all: true });
    const next = list.since(undefined);
    list.observe({ store: fakeStore(), key: "0.3|0.01|0.05|true", threshold: 2 });
    expect(list.since(next)).toMatchObject({ all: true });
  });

  test("a cursor from another server run, the future or a malformed one refreshes everything", () => {
    const list = new UkcTileChanges();
    list.observe({ store: fakeStore(), key: "k", threshold: 2 });
    const head = list.since(undefined);
    expect(list.since({ epoch: "other", rev: head.rev })).toMatchObject({ all: true });
    expect(list.since({ epoch: head.epoch, rev: head.rev + 1 })).toMatchObject({ all: true });
    expect(list.since({ epoch: head.epoch, rev: NaN })).toMatchObject({ all: true });
    expect(new UkcTileChanges().epoch).not.toBe(list.epoch);
  });

  test("an own sounding changing a cell lists the tiles that hold it and the tile it covers", () => {
    const store = fakeStore();
    const list = new UkcTileChanges();
    list.observe({ store, key: "k", threshold: 2 });
    // Living-chart cell (18, 1000, 2000) lies in z14 tile (62, 125) and covers z19 (2000, 4001).
    list.serve(14, 62, 125, { lo: 0, hi: 5 });
    list.serve(14, 63, 125, { lo: 0, hi: 5 });
    list.serve(19, 2000, 4001, { lo: 0, hi: 5 });
    list.serve(19, 2002, 4001, { lo: 0, hi: 5 });
    const start = list.since(undefined);
    store.adjustments.set(tileKey(18, 1000, 2000), cell(3));
    list.observe({ store, key: "k", threshold: 2 });
    const first = list.since(start);
    expect(first.tiles).toEqual([
      [14, 62, 125],
      [19, 2000, 4001]
    ]);
    list.observe({ store, key: "k", threshold: 2 });
    expect(list.since(first).tiles).toEqual([]);
    list.serve(14, 62, 125, { lo: 0, hi: 5 });
    store.adjustments.delete(tileKey(18, 1000, 2000));
    list.observe({ store, key: "k", threshold: 2 });
    expect(list.since(first).tiles).toEqual([[14, 62, 125]]);
  });

  test("a tile no longer tracked is listed, and a client behind the kept list gets all", () => {
    const store = fakeStore();
    const list = new UkcTileChanges(2, 2);
    list.observe({ store, key: "k", threshold: 2 });
    const start = list.since(undefined);
    list.serve(14, 1, 1, { lo: 0, hi: 5 });
    list.serve(14, 1, 2, { lo: 0, hi: 5 });
    list.serve(14, 1, 3, { lo: 0, hi: 5 });
    expect(list.since(start)).toMatchObject({ all: false, tiles: [[14, 1, 1]] });
    const mid = list.since(undefined);
    list.observe({ store, key: "k", threshold: 9 });
    expect(list.since(start)).toMatchObject({ all: true });
    expect(list.since(mid).tiles).toEqual([
      [14, 1, 2],
      [14, 1, 3]
    ]);
  });
});

/** Tiles drawn at the level beyond a source's reach (plan §4.5). */
describe("UKC tile change list with a level source's reach", () => {
  const store = fakeStore();
  /** Tiles x < 3 lie inside the reach `reach`; with "moved", tiles x < 2 do. */
  const inputs = (threshold: number, beyondThreshold: number, reach = "a", key = "k|b") => ({
    store,
    key,
    threshold,
    beyond: {
      threshold: beyondThreshold,
      reach,
      within: (_z: number, x: number) => x < (reach === "moved" ? 2 : 3)
    }
  });
  const served = (list: UkcTileChanges) => {
    for (const x of [1, 2, 3, 4]) {
      list.serve(14, x, 1, { lo: 1.5, hi: 2.5 }, x < 3);
    }
  };

  test("each tile is listed when the threshold of its own level leaves its range", () => {
    const list = new UkcTileChanges();
    list.observe(inputs(2, 2));
    served(list);
    const start = list.since(undefined);
    list.observe(inputs(2, 3));
    const beyond = list.since(start);
    expect(beyond.tiles).toEqual([
      [14, 3, 1],
      [14, 4, 1]
    ]);
    list.observe(inputs(3, 3));
    expect(list.since(beyond).tiles).toEqual([
      [14, 1, 1],
      [14, 2, 1]
    ]);
  });

  test("a moved reach lists exactly the tiles it carries across its edge", () => {
    const list = new UkcTileChanges();
    list.observe(inputs(2, 2));
    served(list);
    const start = list.since(undefined);
    list.observe(inputs(2, 2, "moved"));
    expect(list.since(start)).toMatchObject({ all: false, tiles: [[14, 2, 1]] });
  });

  test("the reach string identifies the geometry: unchanged, no tile is reclassified", () => {
    const list = new UkcTileChanges();
    list.observe(inputs(2, 2));
    served(list);
    const start = list.since(undefined);
    list.observe({ ...inputs(2, 2), beyond: { ...inputs(2, 2).beyond, within: () => false } });
    expect(list.since(start)).toMatchObject({ all: false, tiles: [] });
  });

  test("the beyond level appearing changes the key and refreshes every tile", () => {
    const list = new UkcTileChanges();
    list.observe({ store, key: "0.3|false|-|0.01|0.05", threshold: 2 });
    list.serve(14, 1, 1, { lo: 1, hi: 3 });
    const start = list.since(undefined);
    list.observe(inputs(2, 2, "a", "0.3|false|0.4|true|0.01|0.05"));
    expect(list.since(start)).toMatchObject({ all: true });
  });

  test("a tile served at the other level than the copy held is listed", () => {
    const list = new UkcTileChanges();
    list.observe(inputs(2, 2));
    list.serve(14, 2, 1, { lo: 1.5, hi: 2.5 }, true);
    const start = list.since(undefined);
    list.serve(14, 2, 1, { lo: 1.5, hi: 2.5 }, false);
    const after = list.since(start);
    expect(after.tiles).toEqual([[14, 2, 1]]);
    // The new copy alone is held now: the threshold inside the reach no longer lists it.
    list.observe(inputs(9, 2));
    expect(list.since(after).tiles).toEqual([]);
  });
});

describe("UKC tile change list and block loads", () => {
  /** A store read block by block: `load` marks a z13 block loaded at the next revision. */
  function blockStore() {
    const changed = new Map<string, number>();
    let revision = 0;
    const store = {
      adjustments: new AdjustmentMap(),
      adjustZoom: 18,
      count: 0,
      minZoom: 12,
      entries: () => [],
      surveySigma: () => 0,
      topoSigma: () => 0,
      get loadRevision() {
        return revision;
      },
      blocksChangedSince: (rev: number) =>
        [...changed]
          .filter(([, at]) => at > rev)
          .map(([k]) => {
            const [x, y] = k.split("/").map(Number) as [number, number];
            return { z: 13, x, y };
          })
    } as unknown as NodeStore;
    const load = (x: number, y: number) => changed.set(`${x}/${y}`, ++revision);
    return { store, load };
  }

  test("a tile is listed for a block that changed after it was drawn, not for one its drawing loaded", () => {
    const { store, load } = blockStore();
    const list = new UkcTileChanges();
    const observe = () => list.observe({ store, key: "k", threshold: 2 });
    observe();
    // z14 (20, 20) lies in z13 block (10, 10); (40, 40) lies far from it.
    list.serve(14, 40, 40, { lo: 0, hi: 5 });
    const start = list.since(undefined);
    observe();
    load(10, 10); // read on the spot while (20, 20) was drawn
    list.serve(14, 20, 20, { lo: 0, hi: 5 });
    observe();
    expect(list.since(start).tiles).toEqual([]);
    load(10, 10); // dropped later
    observe();
    expect(list.since(start).tiles).toEqual([[14, 20, 20]]);
  });

  test("a tile drawn before a neighbour's drawing loaded a block it reaches is listed", () => {
    const { store, load } = blockStore();
    const list = new UkcTileChanges();
    const observe = () => list.observe({ store, key: "k", threshold: 2 });
    observe();
    list.serve(14, 20, 20, { lo: 0, hi: 5 });
    const start = list.since(undefined);
    observe();
    load(10, 10); // read while (21, 21), in the same block, was drawn
    list.serve(14, 21, 21, { lo: 0, hi: 5 });
    observe();
    expect(list.since(start).tiles).toEqual([[14, 20, 20]]);
  });

  test("a second copy drawn after a block loaded keeps the tile listable for the first", () => {
    const { store, load } = blockStore();
    const list = new UkcTileChanges();
    const observe = () => list.observe({ store, key: "k", threshold: 2 });
    observe();
    list.serve(14, 20, 20, { lo: 0, hi: 5 });
    const start = list.since(undefined);
    observe();
    load(10, 10); // the second drawing read the block the first copy drew stand-ins for
    list.serve(14, 20, 20, { lo: 0, hi: 5 });
    observe();
    expect(list.since(start).tiles).toEqual([[14, 20, 20]]);
  });
});
