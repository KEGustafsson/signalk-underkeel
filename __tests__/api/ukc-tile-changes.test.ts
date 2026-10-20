import { tileKey } from "../../src/foundation/geo";
import { UkcTileChanges } from "../../src/api/ukc-tile-changes";
import type { NodeStore, NodeValues } from "../../src/spatial/node-store";

function fakeStore(): NodeStore {
  return { adjustments: new Map<number, NodeValues>(), adjustZoom: 18 } as unknown as NodeStore;
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
