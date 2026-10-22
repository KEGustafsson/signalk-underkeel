import fc from "fast-check";
import path from "path";
import { tileKey } from "../../src/foundation/geo";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { NodeValues } from "../../src/spatial/node-store";
import { NodeStore } from "../../src/spatial/node-store";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { deserializePyramid, serializePyramid } from "../../src/spatial/store";
import { FIXTURES } from "../helpers/fixture-index";
import { MapNodeStore } from "../helpers/reference-node-store";

/**
 * The sorted-array node store (IX-5) finds the same node, with the same values,
 * as the Map-per-zoom store it replaced, built or loaded.
 */

const MIN = 10;
const LEAF = 14;

const valuesArb = fc.record({
  dMin: fc.oneof(fc.double({ noNaN: true }), fc.constant(-Infinity)),
  sigmaD: fc.float({ noNaN: true, min: 0 }),
  sigmaP: fc.float({ noNaN: true, min: 0 }),
  flags: fc.integer({ min: 0, max: 127 }),
  cellRef: fc.integer({ min: -1, max: 2000 })
});

// Small x and y ranges, so some tiles are added twice; the later add must win, as in a Map.
const addArb = fc.record({
  z: fc.integer({ min: MIN, max: LEAF }),
  x: fc.integer({ min: 560, max: 600 }),
  y: fc.integer({ min: 290, max: 330 }),
  v: valuesArb,
  split: fc.boolean(),
  survey: fc.float({ noNaN: true, min: 0 })
});

type Store = Pick<NodeStore, "find" | "values" | "isSplit">;

function expectSameNode(a: Store, b: Store, z: number, x: number, y: number): void {
  const i = a.find(z, x, y);
  const j = b.find(z, x, y);
  expect(i === -1).toBe(j === -1);
  if (i !== -1) {
    expect(a.values(i)).toEqual(b.values(j));
    expect(a.isSplit(i)).toBe(b.isSplit(j));
  }
}

describe("sorted-array node store", () => {
  test("finds what the Map store finds, for random adds in any order", () => {
    fc.assert(
      fc.property(fc.array(addArb, { maxLength: 300 }), (adds) => {
        const store = new NodeStore(MIN, LEAF);
        const ref = new MapNodeStore(MIN, LEAF);
        for (const a of adds) {
          store.add(a.z, a.x, a.y, a.v, a.split, a.survey);
          ref.add(a.z, a.x, a.y, a.v, a.split, a.survey);
        }
        expect(store.count).toBe(ref.count);
        for (const a of adds) {
          expectSameNode(store, ref, a.z, a.x, a.y);
          expectSameNode(store, ref, a.z, a.x + 41, a.y);
          expect(store.surveySigmaP[store.find(a.z, a.x, a.y)]).toBe(
            ref.surveySigmaP[ref.find(a.z, a.x, a.y)]
          );
        }
        for (let z = MIN; z <= LEAF; z++) {
          const keys = [...store.entries(z)].map(([x, y, i]) => [tileKey(z, x, y), i]);
          expect(keys).toEqual(
            [...ref.entries(z)]
              .map(([x, y, i]) => [tileKey(z, x, y), i])
              .sort((p, q) => p[0]! - q[0]!)
          );
        }
        expect(store.find(LEAF + 1, 0, 0)).toBe(-1);
        expect(store.find(LEAF, NaN, 0)).toBe(-1);
      }),
      { numRuns: 200 }
    );
  });

  test("dMin survives a save and load exactly, never rounded", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(addArb, valuesArb), { minLength: 1, maxLength: 50 }),
        (adds) => {
          const store = new NodeStore(MIN, LEAF);
          adds.forEach(([a, v]) => store.add(a.z, a.x, a.y, v, a.split, a.survey));
          const loaded = deserializePyramid(serializePyramid(store));
          for (const [a] of adds) {
            const d: NodeValues = store.values(store.find(a.z, a.x, a.y));
            expect(Object.is(loaded.values(loaded.find(a.z, a.x, a.y)).dMin, d.dMin)).toBe(true);
          }
        }
      )
    );
  });
});

test("columns out of zoom order are refused rather than misread", () => {
  const two = (z: number[]) => ({
    z: Uint8Array.from(z),
    key: Float64Array.from([1, 2]),
    dMin: new Float64Array(2),
    sigmaD: new Float32Array(2),
    sigmaP: new Float32Array(2),
    surveySigmaP: new Float32Array(2),
    topoSigmaP: new Float32Array(2),
    bathyDMin: new Float32Array(2),
    flags: new Uint16Array(2),
    cellRef: new Int32Array(2),
    split: new Uint8Array(2)
  });
  expect(() => NodeStore.fromColumns(MIN, LEAF, two([MIN + 1, MIN]))).toThrow(/zoom order/);
  expect(() => NodeStore.fromColumns(MIN, LEAF, two([MIN, LEAF + 1]))).toThrow(/zoom order/);
  expect(NodeStore.fromColumns(MIN, LEAF, two([MIN, MIN])).find(MIN, 0, 2)).toBe(1);
});

describe("the fixture pyramid, built and loaded", () => {
  const features = ["FI4SYNTH", "FI5SYNTH"].flatMap(
    (name, i) => readCellDirectory(path.join(FIXTURES, name), i).features
  );
  const built = buildPyramid(features, { minZoom: 12, leafZoom: 18 });
  const file = serializePyramid(built);
  const loaded = deserializePyramid(file);

  test("every tile at every zoom finds the node the Map store finds", () => {
    const ref = new MapNodeStore(built.minZoom, built.leafZoom);
    for (let z = built.minZoom; z <= built.leafZoom; z++) {
      for (const [x, y, i] of built.entries(z)) {
        ref.add(z, x, y, built.values(i), built.isSplit(i), built.surveySigmaP[i] as number);
      }
    }
    for (let z = built.minZoom; z <= built.leafZoom; z++) {
      const xs = [...built.entries(z)].map(([x]) => x);
      const ys = [...built.entries(z)].map(([, y]) => y);
      for (let x = Math.min(...xs) - 1; x <= Math.max(...xs) + 1; x++) {
        for (let y = Math.min(...ys) - 1; y <= Math.max(...ys) + 1; y++) {
          expectSameNode(built, ref, z, x, y);
          expectSameNode(loaded, ref, z, x, y);
        }
      }
    }
  });
});
