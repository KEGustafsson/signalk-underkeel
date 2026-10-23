import fs from "fs";
import os from "os";
import path from "path";
import type { FetchLike } from "../src/model/fmi";
import type { IndexBuilder } from "../src/wfs-service";
import underkeel = require("../src/index");
import { CELLS, inlineBuilder, prepareFixtureIndex } from "./helpers/fixture-index";
import { fakeApp, fakeClock, fakeRouter, lastValue, navDelta, T0 } from "./helpers/plugin-harness";

/** One depth area over the whole test water, 10 m. */
const fetch: FetchLike = (url) => {
  const first = new URL(url).searchParams.get("startIndex") === "0";
  const features =
    first && url.includes("DepthArea_A")
      ? [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [21.5, 59.8],
                  [22.5, 59.8],
                  [22.5, 60.2],
                  [21.5, 60.2],
                  [21.5, 59.8]
                ]
              ]
            },
            properties: { DRVAL1: "10", IDENTIFIER: "FI 10" }
          }
        ]
      : [];
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ type: "FeatureCollection", features }))
  });
};

/** The worker's job, run in-process: ts-jest has no compiled worker file. */
const build: IndexBuilder = inlineBuilder;

// Loads gdal3.js once: after that a fixture cell is read within one turn of the event loop.
beforeAll(prepareFixtureIndex);

const settle = () => new Promise((r) => setImmediate(r));

describe("plugin with the Traficom WFS source", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-wfs-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test("the engine is off until the first box is indexed, then alert with the notice", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    const plugin = underkeel(h.app, clock, fetch, build);
    plugin.start(
      { vessel: { draft: 2, length: 12, beam: 4 }, wfs: { enabled: true, radiusKm: 3 } },
      () => undefined
    );
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).toBe("off");
    expect(h.statuses).toContain("waiting for the first Traficom WFS download");
    expect(h.errors).toEqual([]);
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(1000);
    expect(lastValue(h.deltas, "navigation.underKeel.state")).toBe("alert");
    const status = call("/v1/status").body as {
      engine: { reason: string };
      wfs: { notice: string; box: { radiusKm: number } };
      index: { cells: { name: string }[] };
    };
    expect(status.engine.reason).toMatch(/not for navigational purposes/);
    expect(status.wfs.box.radiusKm).toBe(3);
    expect(status.index.cells.map((c) => c.name)).toEqual(["FI1WFS01"]);
    plugin.stop();
  });

  test("a living chart started with the first WFS index subscribes its depth path", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    const plugin = underkeel(h.app, clock, fetch, build);
    plugin.start(
      {
        vessel: { draft: 2 },
        wfs: { enabled: true, radiusKm: 3 },
        livechart: { enabled: true }
      },
      () => undefined
    );
    expect(h.subscribed).not.toContain("environment.depth.belowSurface");
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    expect(h.subscribed).toContain("environment.depth.belowSurface");
    plugin.stop();
  });

  test("a confirmed shoal survives the handover to the next box's index (invariant 5)", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    const plugin = underkeel(h.app, clock, fetch, build);
    plugin.start(
      {
        vessel: { draft: 2 },
        wfs: { enabled: true, radiusKm: 3 },
        livechart: { enabled: true, writeNotes: false }
      },
      () => undefined
    );
    const { router, call, post } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const drain = async () => {
      for (let i = 0; i < 20; i++) {
        await settle();
      }
    };
    const fix = (lon: number) => {
      const d = navDelta(lon, 60.0, 0, clock.now());
      d.updates[0]?.values.push(
        { path: "navigation.gnss.methodQuality" as never, value: "GNSS Fix" },
        { path: "navigation.gnss.horizontalDilution" as never, value: 0.8 }
      );
      h.send(d);
    };
    fix(22.0);
    clock.advance(10_000);
    await drain();
    // Two passes reading 6 m over water the WFS charts at 10 m.
    for (const pass of [0, 20 * 60_000]) {
      clock.advance(pass);
      for (let k = 0; k < 3; k++) {
        clock.advance(1000);
        fix(22.0);
        h.send({
          updates: [
            {
              timestamp: new Date(clock.now()).toISOString() as never,
              values: [{ path: "environment.depth.belowSurface" as never, value: 6 }]
            }
          ]
        });
      }
    }
    const shoal = { geometry: { type: "Point", coordinates: [22.0, 60.0] }, draft: 2 };
    const before = (await post("/v1/query", shoal)).body as { charted: number; flags: string[] };
    expect(before.flags).toContain("LIVECHART_ADJUSTED");
    expect(before.charted).toBeLessThan(10);
    const box = (call("/v1/status").body as { wfs: { box: { fetchedAt: string } } }).wfs.box;
    // 2 km east is past half the 3 km radius: the next box is fetched and handed over. The
    // handover first waits for block reads still holding the old index open, which are real I/O.
    fix(22.036);
    clock.advance(10_000);
    const fetchedAt = () =>
      (call("/v1/status").body as { wfs: { box: { fetchedAt: string } } }).wfs.box.fetchedAt;
    for (let i = 0; i < 500 && fetchedAt() === box.fetchedAt; i++) {
      await settle();
    }
    expect(fetchedAt()).not.toBe(box.fetchedAt);
    await drain();
    const after = (await post("/v1/query", shoal)).body as { charted: number; flags: string[] };
    expect(after.flags).toContain("LIVECHART_ADJUSTED");
    expect(after.charted).toBe(before.charted);
    plugin.stop();
  });

  test("a depth path the grounding detector already has is not subscribed again", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    const plugin = underkeel(h.app, clock, fetch, build);
    plugin.start(
      {
        vessel: { draft: 2 },
        wfs: { enabled: true, radiusKm: 3 },
        livechart: { enabled: true },
        groundingDetector: { enabled: true }
      },
      () => undefined
    );
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    expect(h.subscribed.filter((p) => p === "environment.depth.belowSurface")).toHaveLength(1);
    h.send({
      updates: [
        {
          timestamp: new Date(clock.now()).toISOString(),
          values: [{ path: "environment.depth.belowSurface", value: 8 }]
        }
      ]
    } as never);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);
    const lc = (
      call("/v1/status").body as {
        livechart: { accepted: number; rejected: Record<string, number> };
      }
    ).livechart;
    const seen = Object.values(lc.rejected).reduce((a, b) => a + b, lc.accepted);
    expect(seen).toBe(1);
    plugin.stop();
  });

  test("turned back on, the source's saved box is indexed again at start", async () => {
    const clock = fakeClock(T0);
    const cells = (h: ReturnType<typeof fakeApp>, plugin: ReturnType<typeof underkeel>) => {
      const { router, call } = fakeRouter();
      plugin.registerWithRouter?.(router as never);
      const status = call("/v1/status").body as { index: { cells: { name: string }[] } };
      return status.index.cells.map((c) => c.name);
    };
    // Leaf zoom 16: the test builds three indexes and checks only which cells they hold.
    const base = { vessel: { draft: 2 }, cellsDir: CELLS, leafZoom: 16 };
    const on = { ...base, wfs: { enabled: true, radiusKm: 3 } };
    const first = fakeApp(dataDir);
    const a = underkeel(first.app, clock, fetch, build);
    a.start(on, () => undefined);
    first.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    a.stop();
    // Off: the saved index is rebuilt from the ENC cells alone; the box stays on disk.
    const off = underkeel(fakeApp(dataDir).app, clock, fetch, build);
    off.start(base, () => undefined);
    await settle();
    off.stop();
    const again = fakeApp(dataDir);
    const b = underkeel(again.app, clock, fetch, build);
    b.start(on, () => undefined);
    await settle();
    expect(cells(again, b)).toContain("FI1WFS01");
    b.stop();
  });

  test("with the source turned off, a saved index holding the WFS cell is not used", async () => {
    const clock = fakeClock(T0);
    const h = fakeApp(dataDir);
    const plugin = underkeel(h.app, clock, fetch, build);
    plugin.start({ vessel: { draft: 2 }, wfs: { enabled: true, radiusKm: 3 } }, () => undefined);
    h.send(navDelta(22.0, 60.0, 0, clock.now()));
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    plugin.stop();
    const again = fakeApp(dataDir);
    const off = underkeel(again.app, clock, fetch, build);
    off.start({ vessel: { draft: 2 } }, () => undefined);
    expect(lastValue(again.deltas, "navigation.underKeel.state")).toBe("off");
    expect(again.errors.join(" ")).toMatch(/holds Traficom WFS depths and that source is off/);
    off.stop();
  });
});
