import { performance } from "perf_hooks";
import { UkcTileChanges } from "../../src/api/ukc-tile-changes";
import type { LonLat } from "../../src/foundation/geo";
import { offset, tileAt, toMercator } from "../../src/foundation/geo";
import { tileCorners, withinReach } from "../../src/model/level-regimes";
import type { NodeStore } from "../../src/spatial/node-store";
import { AdjustmentMap } from "../../src/spatial/node-store";

/**
 * Cost of a moved FMI forecast point for the tile change list: every served
 * tile is tested against the new reach (plan §4.14). Runs on a REST request
 * after each FMI fetch, not on the 1 Hz tick; target ≤ 20 ms on a Pi 4.
 * Run with `npm run bench`.
 */

describe("UKC tile change list benchmark", () => {
  test("observe() with 4096 served tiles after the reach moves", () => {
    const store = { adjustments: new AdjustmentMap(), adjustZoom: 18 } as unknown as NodeStore;
    const kemi: LonLat = [24.52, 65.67];
    const inputs = (centre: LonLat) => {
      const reach = { centre, metres: 30000 };
      return {
        store,
        key: "k",
        threshold: 2,
        beyond: {
          threshold: 2,
          reach: `${centre[0]},${centre[1]}`,
          within: (z: number, x: number, y: number) => withinReach(reach, tileCorners(z, x, y))
        }
      };
    };
    const [mx, my] = toMercator(kemi[0], kemi[1]);
    const t = tileAt(14, mx, my);
    const served: [number, number][] = [];
    for (let dx = -32; dx < 32; dx++) {
      for (let dy = -32; dy < 32; dy++) {
        served.push([t.x + dx, t.y + dy]);
      }
    }
    const times: number[] = [];
    for (let run = 0; run < 10; run++) {
      const list = new UkcTileChanges();
      const centre = run % 2 === 0 ? kemi : offset(kemi, 8000, 0);
      const first = inputs(centre);
      list.observe(first);
      for (const [x, y] of served) {
        list.serve(14, x, y, { lo: 0, hi: 5 }, first.beyond.within(14, x, y));
      }
      const moved = inputs(run % 2 === 0 ? offset(kemi, 8000, 0) : kemi);
      const start = performance.now();
      list.observe(moved);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(
      `tile change list, reach moved over ${served.length} tiles: median ${(
        (times[5] as number) * 1000
      ).toFixed(0)} µs`
    );
    expect(times[5]).toBeLessThan(200);
  });
});
