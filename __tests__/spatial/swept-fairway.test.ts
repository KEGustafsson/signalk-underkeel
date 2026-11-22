import { pilotBuffer, pilotedBox } from "../../src/engine/pilotage";
import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkRoute } from "../../src/engine/route-check";
import type { LonLat } from "../../src/foundation/geo";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { edgeZoomFor, pluginBuild } from "../../src/spatial/build-items";
import type { Box } from "../helpers/synthetic";
import { CHART_DATUM } from "../helpers/engine";
import { HALF_MAX } from "../../src/ingest/fairway-gaps";
import { HazardIndex } from "../../src/spatial/hazards";
import { BRIDGE_GAP, bridgedChannel, CHANNEL_LAT, gappedChannel } from "../helpers/swept-channel";
import { area, boxRing, coverage, point, quality, swept } from "../helpers/synthetic";

/**
 * A fairway swept to its marks in a cell that charts it with its banks (the Traficom WFS with
 * the FTIA's fairway areas, `ingest/wfs-ftia.ts`): the depth area gives way to the dredged
 * areas covering a tile (`spatial/give-way.ts`), tiles across their edges split to the edge zoom,
 * and a query can tell whether its footprint lies in swept water all through (`sweptOnly`).
 */

const AREA: Box = [22.0, 60.0, 22.02, 60.01];
/** A channel about 22 m wide along 60.005° N, in two pieces meeting at 22.01° E. */
const WEST: Box = [22.0, 60.0049, 22.01, 60.0051];
const EAST: Box = [22.01, 60.0049, 22.02, 60.0051];

function chart() {
  return [
    coverage(AREA),
    quality(AREA, 1),
    // The 0–3 m depth area over the channel and its banks.
    area(AREA, 0),
    area(WEST, 2.7, { dredged: true }),
    area(EAST, 2.7, { dredged: true })
  ];
}

/** A footprint along the channel's line from lon a to lon b, with `buffer` metres about it. */
function along(store: ReturnType<typeof buildPyramid>, a: number, b: number, buffer: number) {
  const geom = footprintGeom([
    [a, 60.005],
    [b, 60.005]
  ]);
  return minDepthOver(store, geom, { bufferMetres: buffer, sweptOnly: true });
}

describe("a swept fairway charted with its banks", () => {
  const store = buildPyramid(chart(), { minZoom: 12, ...pluginBuild(20) });

  test("the depth area gives way inside the channel, the seam between its pieces too", () => {
    const west = along(store, 22.004, 22.006, 3);
    expect(west.dMin).toBe(2.7);
    expect(west.flags & FLAGS.DREDGED).toBe(FLAGS.DREDGED);
    // Across the seam at 22.01° E neither piece holds the tile alone.
    const seam = along(store, 22.0099, 22.0101, 3);
    expect(seam.dMin).toBe(2.7);
    expect(seam.unswept).toBe(false);
  });

  test("a footprint within the channel is swept all through; one reaching the banks is not", () => {
    expect(along(store, 22.004, 22.016, 3).unswept).toBe(false);
    const wide = along(store, 22.004, 22.016, 15);
    expect(wide.unswept).toBe(true);
    expect(wide.dMin).toBe(0);
  });

  test("tiles across the channel's edges split to the edge zoom, finer than the leaf zoom", () => {
    expect(store.leafZoom).toBe(edgeZoomFor(20));
    // At the leaf zoom alone a 19 m tile across the edge keeps the bank's 0 m.
    const coarse = buildPyramid(chart(), { minZoom: 12, leafZoom: 20 });
    expect(along(coarse, 22.004, 22.006, 3).dMin).toBe(0);
    expect(along(store, 22.004, 22.006, 3).dMin).toBe(2.7);
  });

  test("open water reads unswept, and a query not asking says nothing of it", () => {
    const open = buildPyramid([coverage(AREA), quality(AREA, 1), area(AREA, 8)], pluginBuild(20));
    const geom = footprintGeom([[22.005, 60.005]]);
    expect(minDepthOver(open, geom, { bufferMetres: 3, sweptOnly: true }).unswept).toBe(true);
    expect(minDepthOver(open, geom, { bufferMetres: 3 }).unswept).toBeUndefined();
  });
});

describe("sweeps side by side", () => {
  test("two swept areas meeting along a seam guarantee their depth across it", () => {
    const west = { ...swept(WEST, 2.7), objectClass: "SWPARE" };
    const east = swept(EAST, 2.1);
    const features = [...chart(), west, east];
    const store = buildPyramid(features, { minZoom: 12, ...pluginBuild(20) });
    const seam = along(store, 22.0099, 22.0101, 3);
    expect(seam.dMin).toBe(2.1);
    expect(seam.flags & FLAGS.SWEPT).toBe(FLAGS.SWEPT);
    // The guarantee decides the depth's σ: the swept σ, not the survey's.
    const open = buildPyramid(chart(), { minZoom: 12, ...pluginBuild(20) });
    expect(seam.sigmaD).toBeLessThan(along(open, 22.0099, 22.0101, 3).sigmaD);
  });
});

describe("the pilotage buffer", () => {
  const fix = (sigmaPos: number, ok = true) => ({ sigmaPos, ok, reasons: [], divergence: null });

  test("kp times the fix's σ, at least 2 m, while narrower than the least buffer", () => {
    expect(pilotBuffer(fix(1.5), 2, 10)).toBe(3);
    expect(pilotBuffer(fix(0.3), 2, 10)).toBe(2);
    expect(pilotBuffer(fix(6), 2, 10)).toBeUndefined();
  });

  test("none without a good, measured fix", () => {
    expect(pilotBuffer(fix(1.5, false), 2, 10)).toBeUndefined();
    expect(pilotBuffer(undefined, 2, 10)).toBeUndefined();
    expect(pilotBuffer(fix(Number.NaN), 2, 10)).toBeUndefined();
  });
});

describe("pilotage on a swept fairway", () => {
  const index = gappedChannel();
  const NOW = Date.parse("2026-10-18T07:00:00Z");
  const input = (coordinates: LonLat[], pilot?: number): RouteCheckInput => ({
    coordinates,
    departure: NOW,
    speeds: [2.5],
    xteLimit: 3,
    planningBuffer: 10,
    ...(pilot !== undefined && { pilotBuffer: pilot }),
    vessel: { draft: 1.5, length: 8, beam: 2.5 },
    dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => CHART_DATUM,
    probability: 0.01
  });
  const west: LonLat[] = [
    [22.002, CHANNEL_LAT],
    [22.007, CHANNEL_LAT]
  ];
  const across: LonLat[] = [
    [22.006, CHANNEL_LAT],
    [22.014, CHANNEL_LAT]
  ];

  test("a leg swept all through at the pilotage buffer keeps that verdict, flagged PILOTAGE", () => {
    const least = checkRoute(index, input(west), NOW).legs[0];
    // At the least buffer, 13 m each side, the corridor reaches the 0 m banks.
    expect(least?.charted).toBe(0);
    expect(least?.flags).not.toContain("PILOTAGE");
    const piloted = checkRoute(index, input(west, 3), NOW).legs[0];
    expect(piloted?.charted).toBe(2.7);
    expect(piloted?.flags).toEqual(expect.arrayContaining(["PILOTAGE", "DREDGED"]));
  });

  test("a leg across the gap is checked at the least buffer, as without pilotage", () => {
    const least = checkRoute(index, input(across), NOW);
    const piloted = checkRoute(index, input(across, 3), NOW);
    expect(piloted.legs).toEqual(least.legs);
    expect(piloted.legs[0]?.flags).not.toContain("PILOTAGE");
  });

  test("a box swept all through at the pilotage buffer keeps that verdict; one across the gap not", () => {
    const window = { start: NOW, end: NOW + 3_600_000 };
    // ±6 m and ±13 m about the channel's line: xteLimit plus each buffer, as `grownBox` grows it.
    const narrow = (a: number, b: number) =>
      boxRing([a, CHANNEL_LAT - 0.000054, b, CHANNEL_LAT + 0.000054]);
    const ring = (a: number, b: number) =>
      boxRing([a, CHANNEL_LAT - 0.000117, b, CHANNEL_LAT + 0.000117]);
    const inWest = { ring: ring(22.002, 22.007), narrow: narrow(22.002, 22.007) };
    const kept = pilotedBox(index, input([]), inWest, 2.5, window);
    expect(kept.flags).toEqual(expect.arrayContaining(["PILOTAGE", "DREDGED"]));
    expect(kept.unswept).toBe(false);
    const leastOnly = pilotedBox(index, input([]), { ...inWest, narrow: undefined }, 2.5, window);
    expect(leastOnly.flags).not.toContain("PILOTAGE");
    expect(kept.risk).toBeLessThan(leastOnly.risk);

    const gap = { ring: ring(22.006, 22.014), narrow: narrow(22.006, 22.014) };
    const fallback = pilotedBox(index, input([]), gap, 2.5, window);
    const least = pilotedBox(index, input([]), { ...gap, narrow: undefined }, 2.5, window);
    expect(fallback.flags).not.toContain("PILOTAGE");
    expect({ ...fallback, work: 0 }).toEqual({ ...least, work: 0 });
    expect(fallback.work).toBeGreaterThan(least.work);
  });
});

describe("pilotage through a fairway gap", () => {
  const index = bridgedChannel();
  const NOW = Date.parse("2026-10-18T07:00:00Z");
  /** Metres north of the line, in degrees of latitude. */
  const north = (m: number) => m / 111_320;
  const input = (
    coordinates: LonLat[],
    pilot?: number,
    extra: Partial<RouteCheckInput> = {}
  ): RouteCheckInput => ({
    coordinates,
    departure: NOW,
    speeds: [2.5],
    // The planner's narrows: the boat on its leg, its own fix the only width.
    xteLimit: 0,
    planningBuffer: 10,
    ...(pilot !== undefined && { pilotBuffer: pilot }),
    vessel: { draft: 1.5, length: 8, beam: 2.5 },
    dynamics: DEFAULT_DYNAMICS,
    waterLevel: () => CHART_DATUM,
    probability: 0.01,
    ...extra
  });
  /** A leg through the gap `off` metres north of the line. */
  const through = (off = 0): LonLat[] => [
    [22.006, CHANNEL_LAT + north(off)],
    [22.014, CHANNEL_LAT + north(off)]
  ];
  const leg = (i: RouteCheckInput) => checkRoute(index, i, NOW).legs[0];

  test("the strip is none of the index's depths", () => {
    const inGap = footprintGeom([[(BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2, CHANNEL_LAT]]);
    const q = minDepthOver(index.pyramid, inGap, { bufferMetres: 3, sweptOnly: true });
    expect(q.dMin).toBe(0);
    expect(q.unswept).toBe(true);
  });

  test("a check without pilotage reads the gap at its charted depth and refuses it", () => {
    const plain = leg(input(through()));
    expect(plain?.status).toBe("fail");
    expect(plain?.charted).toBe(0);
    expect(plain?.flags).not.toContain("PILOTAGE");
  });

  test("with a good fix a leg on the line is held to the strip's depth, flagged PILOTAGE", () => {
    const piloted = leg(input(through(), 3));
    expect(piloted?.status).toBe("ok");
    expect(piloted?.charted).toBe(2.7);
    expect(piloted?.flags).toEqual(expect.arrayContaining(["PILOTAGE", "SWEPT"]));
    // A leg ending under the bridge, and the next leaving from there, are held to it as well.
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const legs = checkRoute(
      index,
      {
        ...input(
          [
            [22.006, CHANNEL_LAT],
            [mid, CHANNEL_LAT],
            [22.014, CHANNEL_LAT]
          ],
          3
        ),
        speeds: [2.5, 2.5]
      },
      NOW
    ).legs;
    expect(legs.map((l) => [l.status, l.flags.includes("PILOTAGE")])).toEqual([
      ["ok", true],
      ["ok", true]
    ]);
  });

  test("off the line by more than the strip's half-width less the pilotage buffer, refused", () => {
    // 6 m off with a 3 m buffer reaches 9 m, inside the strip's 10 m.
    expect(leg(input(through(6), 3))?.flags).toContain("PILOTAGE");
    expect(leg(input(through(6), 3))?.charted).toBe(2.7);
    // 8 m off reaches 11 m: past the strip, into the gap's charted 0 m.
    const off = leg(input(through(8), 3));
    expect(off?.status).toBe("fail");
    expect(off?.charted).toBe(0);
    expect(off?.flags).not.toContain("PILOTAGE");
    // The cross-track limit widens the corridor as it does in swept water: 3 m and 3 m, 8 m off.
    expect(leg(input(through(5), 3, { xteLimit: 3 }))?.charted).toBe(0);
  });

  test("a pilotage buffer as wide as the strip's half-width closes it", () => {
    const wide = leg(input(through(), HALF_MAX, { planningBuffer: 15 }));
    expect(wide?.status).toBe("fail");
    expect(wide?.charted).toBe(0);
    expect(wide?.flags).not.toContain("PILOTAGE");
  });

  test("a fix too poor for pilotage closes it", () => {
    const poor = { sigmaPos: 1.5, ok: false, reasons: [], divergence: null };
    const buffer = pilotBuffer(poor, 2, 10);
    expect(buffer).toBeUndefined();
    const refused = leg(input(through(), buffer));
    expect(refused?.status).toBe("fail");
    expect(refused?.flags).not.toContain("PILOTAGE");
  });

  test("a charted sounding in the strip shallower than it closes it", () => {
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const shoal = { ...index, hazards: new HazardIndex([point(mid, CHANNEL_LAT + north(7), 1.2)]) };
    const r = checkRoute(shoal, input(through(), 3), NOW).legs[0];
    expect(r?.flags).not.toContain("PILOTAGE");
    expect(r?.charted).toBe(0);
  });

  test("a box inside the strip is held to its depth; one reaching past it is not", () => {
    const window = { start: NOW, end: NOW + 3_600_000 };
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const box = (half: number) =>
      boxRing([mid - 0.0002, CHANNEL_LAT - north(half), mid + 0.0002, CHANNEL_LAT + north(half)]);
    const inside = { ring: box(13), narrow: box(6) };
    const held = pilotedBox(index, input([]), inside, 2.5, window);
    expect(held.status).toBe("ok");
    expect(held.flags).toEqual(expect.arrayContaining(["PILOTAGE", "SWEPT"]));
    const past = pilotedBox(index, input([]), { ring: box(13), narrow: box(11) }, 2.5, window);
    expect(past.flags).not.toContain("PILOTAGE");
    expect(past.status).toBe("fail");
  });
});
