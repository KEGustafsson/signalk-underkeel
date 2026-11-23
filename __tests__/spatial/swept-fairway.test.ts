import { heldDepth } from "../../src/engine/gap-strips";
import { heldBox } from "../../src/engine/held-box";
import { roomOf } from "../../src/engine/room";
import type { RouteCheckInput } from "../../src/engine/route-check";
import { checkFootprint, checkRoute } from "../../src/engine/route-check";
import type { LonLat } from "../../src/foundation/geo";
import { toMercator } from "../../src/foundation/geo";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { edgeZoomFor, pluginBuild } from "../../src/spatial/build-items";
import type { Box } from "../helpers/synthetic";
import { CHART_DATUM } from "../helpers/engine";
import { HALF_MAX } from "../../src/ingest/fairway-gaps";
import { HazardIndex } from "../../src/spatial/hazards";
import {
  BRIDGE_GAP,
  bridgedChannel,
  CHANNEL_AREA,
  CHANNEL_LAT,
  gappedChannel
} from "../helpers/swept-channel";
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

describe("a corridor in a swept fairway: the cross-track limit and half the beam", () => {
  const index = gappedChannel();
  const NOW = Date.parse("2026-10-18T07:00:00Z");
  const input = (coordinates: LonLat[], hullBuffer = 1.25): RouteCheckInput => ({
    coordinates,
    departure: NOW,
    speeds: [2.5],
    xteLimit: 3,
    hullBuffer,
    vessel: { draft: 1.5, length: 8, beam: 2 * hullBuffer },
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
  const window = { start: NOW, end: NOW + 3_600_000 };
  /** The box from `a` to `b` along the line grown `half` metres each side, as `grownBox` grows it. */
  const box = (a: number, b: number, half: number) =>
    boxRing([a, CHANNEL_LAT - half / 111_320, b, CHANNEL_LAT + half / 111_320]);

  test("keeps in the dredged water, 11 m each side, at 3 m and a 2.5 m beam", () => {
    const leg = checkRoute(index, input(west), NOW).legs[0];
    // The dredged 2.7 m, not the banks' 0 m; at this survey's σ a 1.5 m keel is marginal there.
    expect(leg?.charted).toBe(2.7);
    expect(leg?.status).not.toBe("fail");
    expect(leg?.flags).toContain("DREDGED");
    expect(leg?.flags).not.toContain("FAIRWAY_GAP");
  });

  test("a hull wide enough to reach the banks reads their 0 m", () => {
    const leg = checkRoute(index, input(west, 10), NOW).legs[0];
    expect(leg?.status).toBe("fail");
    expect(leg?.charted).toBe(0);
  });

  test("a leg across the gap, with no strip, reads the gap's charted depth", () => {
    const leg = checkRoute(index, input(across), NOW).legs[0];
    expect(leg?.status).toBe("fail");
    expect(leg?.charted).toBe(0);
  });

  test("a box reads as a leg does, never riskier than through the index alone", () => {
    const ring = box(22.002, 22.007, 4.25);
    const held = heldBox(index, input([]), ring, 2.5, window);
    const plain = checkFootprint(index, input([]), ring, 2.5, { ...window, at: ring });
    expect(held.status).not.toBe("fail");
    expect(held.flags).toContain("DREDGED");
    expect(held.risk).toBeLessThanOrEqual(plain.risk);
    expect(heldBox(index, input([]), box(22.006, 22.014, 4.25), 2.5, window).status).toBe("fail");
  });

  test("a leg's room: how far the swept water reaches past the hull", () => {
    const ends = west as [LonLat, LonLat];
    const room = roomOf(index, ends, 1.25, [0, 10]) as number;
    // 11 m dredged each side, less the hull's 1.25 m and a tile at the edge.
    expect(room).toBeGreaterThanOrEqual(3);
    expect(room).toBeLessThanOrEqual(9.75);
    expect(roomOf(index, across as [LonLat, LonLat], 1.25, [0, 10])).toBeUndefined();
  });
});

describe("through a fairway gap", () => {
  const index = bridgedChannel();
  const NOW = Date.parse("2026-10-18T07:00:00Z");
  /** Metres north of the line, in degrees of latitude. */
  const north = (m: number) => m / 111_320;
  const input = (coordinates: LonLat[], extra: Partial<RouteCheckInput> = {}): RouteCheckInput => ({
    coordinates,
    departure: NOW,
    speeds: [2.5],
    // The planner's narrows: the boat on its leg, its hull the only width.
    xteLimit: 0,
    hullBuffer: 1.25,
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

  test("a leg on the line is held to the strip's depth, flagged FAIRWAY_GAP", () => {
    const held = leg(input(through()));
    expect(held?.status).toBe("ok");
    expect(held?.charted).toBe(2.7);
    expect(held?.flags).toEqual(expect.arrayContaining(["FAIRWAY_GAP", "SWEPT"]));
    // A leg ending under the bridge, and the next leaving from there, are held to it as well.
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const legs = checkRoute(
      index,
      {
        ...input([
          [22.006, CHANNEL_LAT],
          [mid, CHANNEL_LAT],
          [22.014, CHANNEL_LAT]
        ]),
        speeds: [2.5, 2.5]
      },
      NOW
    ).legs;
    expect(legs.map((l) => [l.status, l.flags.includes("FAIRWAY_GAP")])).toEqual([
      ["ok", true],
      ["ok", true]
    ]);
  });

  test("off the line by more than the strip's half-width less the hull's, refused", () => {
    // 6 m off with a 3 m half-beam reaches 9 m, inside the strip's 10 m.
    const inside = leg(input(through(6), { hullBuffer: 3 }));
    expect(inside?.flags).toContain("FAIRWAY_GAP");
    expect(inside?.charted).toBe(2.7);
    // 8 m off reaches 11 m: past the strip, into the gap's charted 0 m.
    const off = leg(input(through(8), { hullBuffer: 3 }));
    expect(off?.status).toBe("fail");
    expect(off?.charted).toBe(0);
    expect(off?.flags).not.toContain("FAIRWAY_GAP");
    // The cross-track limit widens the corridor: 3 m and 3 m, 5 m off, reaches 11 m.
    expect(leg(input(through(5), { hullBuffer: 3, xteLimit: 3 }))?.charted).toBe(0);
  });

  test("a hull as wide as the strip closes it", () => {
    const wide = leg(input(through(), { hullBuffer: HALF_MAX }));
    expect(wide?.status).toBe("fail");
    expect(wide?.charted).toBe(0);
    expect(wide?.flags).not.toContain("FAIRWAY_GAP");
  });

  test("a leg through the gap gets its room from the strip", () => {
    const room = roomOf(index, through() as [LonLat, LonLat], 1.25, [0, 10]) as number;
    expect(room).toBeGreaterThanOrEqual(3);
    expect(room).toBeLessThanOrEqual(HALF_MAX - 1.25);
    expect(leg(input(through(), { hullBuffer: 1.25 + room }))?.flags).toContain("FAIRWAY_GAP");
    expect(leg(input(through(), { hullBuffer: 1.25 + room + 0.5 }))?.flags).not.toContain(
      "FAIRWAY_GAP"
    );
  });

  test("a charted sounding in the strip shallower than it closes it", () => {
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const shoal = { ...index, hazards: new HazardIndex([point(mid, CHANNEL_LAT + north(7), 1.2)]) };
    const r = checkRoute(shoal, input(through(), { hullBuffer: 3 }), NOW).legs[0];
    expect(r?.flags).not.toContain("FAIRWAY_GAP");
    expect(r?.charted).toBe(0);
  });

  test("a footprint in the strip that the index does not cover all through is unswept", () => {
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const [w, s] = toMercator(CHANNEL_AREA[0], CHANNEL_AREA[1]);
    const [e, n] = toMercator(mid, CHANNEL_AREA[3]);
    // Charted water to the gap's middle, and past it only kept for its reach into the box.
    const pyramid = buildPyramid(
      [coverage(CHANNEL_AREA), quality(CHANNEL_AREA, 1), area(CHANNEL_AREA, 0)],
      { minZoom: 12, ...pluginBuild(20), within: { minX: w, minY: s, maxX: e, maxY: n } }
    );
    const box = (west: number, east: number) =>
      boxRing([west, CHANNEL_LAT - north(3), east, CHANNEL_LAT + north(3)]);
    const read = (ring: LonLat[]) =>
      heldDepth({ ...index, pyramid }, ring, { depth: 2.7, cellRef: 0 }, risk).result;
    const risk = { threshold: 1.5, sigmaExtra: 0 };
    expect(read(box(mid - 0.003, mid - 0.002)).unswept).toBe(false);
    const across = read(box(mid - 0.0001, mid + 0.0001));
    expect([across.unswept, across.flags & FLAGS.SWEPT]).toEqual([true, 0]);
  });

  test("a box inside the strip is held to its depth; one reaching past it is not", () => {
    const window = { start: NOW, end: NOW + 3_600_000 };
    const mid = (BRIDGE_GAP[0] + BRIDGE_GAP[1]) / 2;
    const box = (half: number) =>
      boxRing([mid - 0.0002, CHANNEL_LAT - north(half), mid + 0.0002, CHANNEL_LAT + north(half)]);
    const held = heldBox(index, input([]), box(6), 2.5, window);
    expect(held.status).toBe("ok");
    expect(held.flags).toEqual(expect.arrayContaining(["FAIRWAY_GAP", "SWEPT"]));
    const past = heldBox(index, input([]), box(11), 2.5, window);
    expect(past.flags).not.toContain("FAIRWAY_GAP");
    expect(past.status).toBe("fail");
  });
});
