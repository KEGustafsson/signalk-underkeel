import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import type { LonLat, Rect } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import { cellsNear } from "../../src/livechart/rebind";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import type { NodeStore } from "../../src/spatial/node-store";
import type { Box } from "../helpers/synthetic";
import { area, basin, coverage, quality } from "../helpers/synthetic";

const T0 = 1_800_000_000_000;
const CONFIG: LivechartConfig = {
  source: { path: "environment.depth.belowSurface", transducerDepth: 0, forward: 0, starboard: 0 },
  writeNotes: false,
  csb: { id: "anon", idType: "Other" }
};
const ENC: Box = [22.0, 60.0, 22.1, 60.05];

/**
 * The ENC basin, CATZOC C so its tiles reach 500 m, and a band-1 box at `wfs`: advisory, as
 * the Traficom WFS cell is, or CATZOC C, so that its own tiles reach beyond it.
 */
const index = (wfs: Box, advisory = true): NodeStore =>
  buildPyramid(
    [
      ...basin(ENC, 8),
      quality(ENC, 3),
      coverage(wfs, { cellRef: 1, band: 1 }),
      ...(advisory ? [] : [quality(wfs, 3, { cellRef: 1, band: 1 })]),
      { ...area(wfs, 3, { cellRef: 1, band: 1 }), advisory }
    ],
    { minZoom: 12, leafZoom: 18 }
  );

const rect = ([w, s, e, n]: Box): Rect => {
  const [minX, minY] = toMercator(w, s);
  const [maxX, maxY] = toMercator(e, n);
  return { minX, minY, maxX, maxY };
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function service(store: NodeStore, soundings: [LonLat, number][]): LivechartService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-rebind-"));
  dirs.push(dir);
  const svc = new LivechartService(store, CONFIG, path.join(dir, "livechart.json"), {
    setNote: () => Promise.resolve(),
    error: (m) => {
      throw new Error(m);
    },
    now: () => T0
  });
  // Two passes, so cells can become discrepancies on either chart.
  for (const pass of [0, 15 * 60_000]) {
    soundings.forEach(([position, depth], i) =>
      svc.onSounding({
        depth,
        at: T0 + pass + i * 1000,
        position,
        positionAt: T0 + pass + i * 1000,
        hdop: 0.9,
        methodQuality: "GNSS Fix",
        waterLevel: { h: 0, sigma: 0.05, source: "manual" }
      })
    );
  }
  return svc;
}

const cellsOf = (svc: LivechartService) =>
  [...(svc as unknown as { posteriors: { cells: Map<number, unknown> } }).posteriors.cells].sort(
    (a, b) => a[0] - b[0]
  );

const box = fc
  .tuple(fc.double({ min: 21.98, max: 22.12 }), fc.double({ min: 59.99, max: 60.05 }))
  .map(([w, s]): Box => [w, s, w + 0.03, s + 0.015]);

describe("living-chart rebind onto a rebuilt index (PL5)", () => {
  test("rebinding only the cells near the changed boxes equals rebinding every cell", async () => {
    await fc.assert(
      fc.asyncProperty(
        box,
        box,
        fc.boolean(),
        fc.array(
          fc.tuple(
            fc.double({ min: 21.97, max: 22.16, noNaN: true }),
            fc.double({ min: 59.98, max: 60.07, noNaN: true }),
            fc.double({ min: 1, max: 12 })
          ),
          { minLength: 1, maxLength: 60 }
        ),
        async (before, after, advisory, raw) => {
          const soundings = raw.map(([lon, lat, d]): [LonLat, number] => [[lon, lat], d]);
          const full = service(index(before, advisory), soundings);
          const fullStore = index(after, advisory);
          full.rebind(fullStore);
          const near = service(index(before, advisory), soundings);
          const nearStore = index(after, advisory);
          const apply = await near.prepareRebind(
            nearStore,
            cellsNear([rect(before), rect(after)]),
            () => new Promise((r) => setImmediate(r))
          );
          apply();
          expect(cellsOf(near)).toEqual(cellsOf(full));
          expect([...nearStore.adjustments]).toEqual([...fullStore.adjustments]);
        }
      ),
      { numRuns: 25 }
    );
  }, 60_000);

  test("a cell that gets a sounding while the rebind is prepared is rebased with it", async () => {
    const at: LonLat = [22.05, 60.02];
    const svc = service(index([22.12, 60.0, 22.15, 60.01]), [[at, 5]]);
    const store = index([22.12, 60.0, 22.15, 60.01]);
    const reference = service(index([22.12, 60.0, 22.15, 60.01]), [[at, 5]]);
    const extra = {
      depth: 4,
      at: T0 + 3_600_000,
      position: at,
      positionAt: T0 + 3_600_000,
      hdop: 0.9,
      methodQuality: "GNSS Fix",
      waterLevel: { h: 0, sigma: 0.05, source: "manual" }
    };
    const apply = await svc.prepareRebind(
      store,
      () => true,
      () => {
        svc.onSounding(extra);
        return Promise.resolve();
      }
    );
    apply();
    reference.onSounding(extra);
    const referenceStore = index([22.12, 60.0, 22.15, 60.01]);
    reference.rebind(referenceStore);
    expect(cellsOf(svc)).toEqual(cellsOf(reference));
    expect([...store.adjustments]).toEqual([...referenceStore.adjustments]);
  });
});
