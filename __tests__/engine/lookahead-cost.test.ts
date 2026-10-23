import fc from "fast-check";
import type { FootprintResult, NavState } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import { MAX_POSITION_BUFFER } from "../../src/engine/fan";
import { uncertainPosition } from "../../src/engine/verdict";
import type { VesselModel } from "../../src/model/vessel";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { fromMercator, tileAt, tileRect, toMercator } from "../../src/foundation/geo";
import { HazardIndex } from "../../src/spatial/hazards";
import { NodeStore } from "../../src/spatial/node-store";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { ctx } from "../helpers/engine";
import type { Box } from "../helpers/synthetic";
import { uniform } from "../helpers/arbitraries";
import { basin, land, point } from "../helpers/synthetic";

/**
 * The look-ahead's cost bounds (plan §4.8) change how much chart a tick
 * reads, never the state a footprint that decides it reports.
 */

const NOW = 1_800_000_000_000;
const KEEL: VesselModel = { draft: 1.9, length: 12, beam: 4 };
const EAST = Math.PI / 2;
const LAT = 60.005;
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180);
const CHART: Box = [22.0, 60.0, 22.04, 60.01];
/** A 30 m strip of land along the chart's east edge; past it there is no coverage. */
const STRIP: Box = [CHART[2] - 30 / M_PER_DEG_LON, 60.004, CHART[2], 60.006];

function indexOf(features: ReturnType<typeof basin>): ChartIndex {
  return {
    catalogue: { version: 1, cells: [] },
    pyramid: buildPyramid(features, { minZoom: 12, leafZoom: 18 }),
    hazards: new HazardIndex([])
  };
}

function nav(lon: number, lat = LAT): NavState {
  const sog = 3;
  return {
    position: { value: [lon, lat], at: NOW },
    cog: { value: EAST, at: NOW },
    sog: { value: sog, at: NOW },
    heading: { value: EAST, at: NOW }
  };
}

/** Longitude `metres` west of the strip. */
const westOfStrip = (metres: number) => STRIP[0] - metres / M_PER_DEG_LON;

describe("certain land ends a footprint's chart walk", () => {
  test("land at the coverage edge under the vessel is an alarm", () => {
    const index = indexOf([...basin(CHART, 20), land(STRIP)]);
    const r = evaluateLookahead(nav(westOfStrip(-15)), ctx(KEEL), index, NOW);
    expect(r.state).toBe("alarm");
    expect(r.reason).toBe("shoal under the vessel");
    expect(r.footprints[0]?.risk).toBe(1);
  });

  /**
   * Four z16 tiles meet at a corner: water to the west, land to the north-east
   * and no chart to the south-east. A footprint on the corner walks the land
   * tile before the gap, so an early stop there would miss the gap.
   */
  const hazards = new HazardIndex([]);

  function corner(): { index: ChartIndex; at: (metres: number) => NavState } {
    const store = new NodeStore(16, 16);
    const [cx, cy] = toMercator(22.02, LAT);
    const { x, y } = tileAt(16, cx, cy);
    const water = { dMin: 20, sigmaD: 0.1, sigmaP: 1, flags: 0, cellRef: 0 };
    for (let dx = -3; dx <= 0; dx++) {
      for (const dy of [-1, 0, 1, 2]) {
        store.add(16, x + dx, y + dy, water, false, 0);
      }
    }
    store.add(16, x + 1, y, { ...water, dMin: -Infinity }, false, 0);
    const r = tileRect(16, x + 1, y);
    const [lon, lat] = fromMercator(r.minX, r.minY);
    const index = { catalogue: { version: 1 as const, cells: [] }, pyramid: store, hazards };
    const perDegree = 111320 * Math.cos((lat * Math.PI) / 180);
    const at = (metres: number) => nav(lon - metres / perDegree, lat);
    return { index, at };
  }

  test("past the warn window, land at a coverage gap still reports the gap", () => {
    const { index, at } = corner();
    // The horizon is 555.6 m / 3 m/s = 185 s; only footprints past 160 s reach the corner.
    const r = evaluateLookahead(at(555), ctx(KEEL), index, NOW);
    const reached = r.footprints.filter((f) => f.risk === 1);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((f) => f.t > DEFAULT_LOOKAHEAD.warnWithin)).toBe(true);
    expect(reached.some((f) => f.uncovered)).toBe(true);
    expect(r.state).toBe("warn");
    expect(r.reason).toMatch(/^no chart coverage ahead in \d+ s$/);
  });

  test("inside the warn window the land decides the state", () => {
    const { index, at } = corner();
    const r = evaluateLookahead(at(300), ctx(KEEL), index, NOW);
    expect(r.state).toBe("warn");
    expect(r.reason).toMatch(/^shoal ahead in \d+ s$/);
    expect(r.timeToShoal).toBeLessThanOrEqual(DEFAULT_LOOKAHEAD.warnWithin);
  });
});

describe("coarse steps beyond the warn window", () => {
  /** A seeded field of shoal rocks in 20 m water. */
  function rockField(): ChartIndex {
    let seed = 7;
    const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const rocks = Array.from({ length: 60 }, () =>
      point(22.0 + r() * 0.04, 60.0 + r() * 0.01, 1.5 + r() * 2.5)
    );
    return indexOf([...basin(CHART, 20), ...rocks]);
  }
  const index = rockField();
  const opts = { ...DEFAULT_LOOKAHEAD, distance: 600, minHorizon: 60 };
  /**
   * With no warn window every footprint is a plan step, as the engine scored
   * before coarse steps; only the state table differs, which these tests
   * leave out. They look 350 m ahead, where a horizon of plan steps fits in
   * MAX_FOOTPRINTS down to 0.3 m/s: farther, only the coarse tick would
   * keep the plan step inside the windows.
   */
  const near = { ...opts, distance: 350 };
  const fine = { ...near, warnWithin: Infinity };

  const navArb = fc.record({
    x: uniform(0.2, 0.8),
    y: uniform(0.2, 0.8),
    cog: uniform(0, 2 * Math.PI),
    sog: uniform(0.3, 2.5),
    rot: uniform(-0.03, 0.03)
  });

  function navOf(n: { x: number; y: number; cog: number; sog: number; rot: number }): NavState {
    const at = NOW;
    return {
      position: { value: [22.0 + n.x * 0.04, 60.0 + n.y * 0.01], at },
      cog: { value: n.cog, at },
      sog: { value: n.sog, at },
      heading: { value: n.cog, at },
      rot: { value: n.rot, at }
    };
  }

  test("every tile a plan-step footprint reaches beyond the window, a coarse one reaches", () => {
    fc.assert(
      fc.property(navArb, (n) => {
        const coarse = evaluateLookahead(navOf(n), ctx(KEEL), index, NOW, near);
        const dense = evaluateLookahead(navOf(n), ctx(KEEL), index, NOW, fine);
        // From the first coarse footprint, the first on the grid at or past the window: the dense
        // steps after it lie between it and the next coarse one.
        const beyond = (fps: FootprintResult[]) => fps.filter((f) => f.t >= opts.warnWithin - 1e-6);
        const flags = (fps: FootprintResult[]) => fps.reduce((u, f) => u | f.flags, 0);
        expect(flags(beyond(dense.footprints)) & ~flags(beyond(coarse.footprints))).toBe(0);
        // A coarse footprint covers the plan steps it skips, so under graded chart
        // position (plan §4.3) it reads every tile at least as near: never a lower P or a
        // deeper clearance, and the time to shoal is scored on the plan steps.
        expect(coarse.risk as number).toBeGreaterThanOrEqual(dense.risk as number);
        if (coarse.clearance !== null && dense.clearance !== null) {
          expect(coarse.clearance).toBeLessThanOrEqual(dense.clearance);
        }
        expect(coarse.timeToShoal).toBe(dense.timeToShoal);
        expect(coarse.footprints.length).toBeLessThanOrEqual(dense.footprints.length);
        const within = (fps: FootprintResult[]) =>
          fps.filter((f) => f.t <= opts.warnWithin).map((f) => [f.t, f.risk, f.flags]);
        expect(within(coarse.footprints)).toEqual(within(dense.footprints));
      }),
      {
        numRuns: 40,
        examples: [
          // From CI: a turning boat whose coarse hull, taken in lon/lat, left a step's footprint
          // 2.5 µm outside it in Mercator.
          [{ x: 0.53954, y: 0.72002, cog: 0, sog: 1.32432, rot: -0.029976 }],
          // From CI: a rock just past a plan step's buffer and within the coarse one's read its
          // float32 survey depth there, 1 ulp shallower than its depth within, and a higher P.
          [{ x: 0.79328, y: 0.4943, cog: 2.3147254671649597, sog: 0.3, rot: 0.020586 }],
          // From CI: a turning boat whose coarse hull reached a rock inside its arc at 225 s that
          // no plan step reaches before 708 s.
          [{ x: 0.68126, y: 0.2, cog: 6.268733980973073, sog: 0.3, rot: 0.016596 }]
        ]
      }
    );
  });

  test("a slow boat scores tens of footprints, not hundreds", () => {
    const r = evaluateLookahead(
      navOf({ x: 0.5, y: 0.5, cog: EAST, sog: 0.5, rot: 0 }),
      ctx(KEEL),
      index,
      NOW,
      opts
    );
    // 1200 s horizon in 3 s steps; beyond 120 s every 21st, as (12 + 20) / 0.5 = 64 s.
    expect(r.horizon).toBe(1200);
    const step = 3;
    const gaps = r.footprints.slice(1).map((f, i) => f.t - (r.footprints[i] as FootprintResult).t);
    expect(gaps.slice(0, 40).every((g) => Math.abs(g - step) < 1e-9)).toBe(true);
    expect(gaps.slice(40, -1).every((g) => Math.abs(g - 21 * step) < 1e-9)).toBe(true);
    expect(r.footprints.length).toBe(59);
  });
});

describe("position uncertainty beyond the buffer cap", () => {
  const index = indexOf([...basin([21.9, 59.97, CHART[2], 60.04], 20), land(STRIP)]);
  const inputs = (positionSigma: number, positionReason?: string) => ({
    ...ctx(KEEL),
    positionSigma,
    positionReason,
    escape: true
  });
  const open = nav(westOfStrip(1500));

  test("below the cap the buffer is k_p · σ_pos and open water is normal", () => {
    const r = evaluateLookahead(open, inputs(200), index, NOW);
    expect(r.state).toBe("normal");
    expect(r.footprints.every((f) => f.buffer === 400)).toBe(true);
  });

  test("above it the buffer stops at the cap and the state is warn with the reason", () => {
    const why = "GNSS and dead reckoning differ by 1996 m";
    const r = evaluateLookahead(open, inputs(1996, why), index, NOW);
    expect(r.footprints.every((f) => f.buffer === MAX_POSITION_BUFFER)).toBe(true);
    expect(r.state).toBe("warn");
    expect(r.reason).toBe(`position uncertainty 1996 m: ${why}`);
    expect(r.escapeHeading).toBeNull();
    // Nor may the monitor publish one it found before the cap.
    expect(r.escapable).toBe(false);
    expect(evaluateLookahead(open, inputs(200), index, NOW).escapable).toBe(true);
    // No acknowledgement or zone may lower it, whatever reason hysteresis holds.
    expect(r.capped).toBe(true);
    expect(evaluateLookahead(open, inputs(200), index, NOW).capped).toBe(false);
  });

  test("a reason the state already had stays beside the position one", () => {
    const stale = { state: "unknown" as const, reason: "course or speed stale", tts: null };
    expect(uncertainPosition(stale, 1996).reason).toBe(
      "position uncertainty 1996 m; course or speed stale"
    );
    expect(uncertainPosition({ ...stale, reason: "" }, 1996).reason).toBe(
      "position uncertainty 1996 m"
    );
  });

  test("land within the capped buffer still alarms", () => {
    const r = evaluateLookahead(nav(westOfStrip(300)), inputs(1996), index, NOW);
    expect(r.state).toBe("alarm");
  });

  test("σ_pos above the cap never publishes normal or alert", () => {
    fc.assert(
      fc.property(uniform(0, 3000), uniform(250.5, 5000), (metres, sigma) => {
        const r = evaluateLookahead(nav(westOfStrip(metres)), inputs(sigma), index, NOW);
        expect(["warn", "alarm"]).toContain(r.state);
      }),
      { numRuns: 30 }
    );
  });
});
