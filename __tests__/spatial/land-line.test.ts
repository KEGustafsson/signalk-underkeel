import type { LonLat } from "../../src/foundation/geo";
import type { ChartFeature } from "../../src/ingest/features";
import { edgeZoomFor } from "../../src/spatial/build-items";
import { crossesLand } from "../../src/spatial/land-line";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { pyramidFromBuffer, serializePyramid } from "../../src/spatial/store";
import type { Box } from "../helpers/synthetic";
import { area, coverage, land, quality } from "../helpers/synthetic";

/**
 * Land under a leg's own line (`land-line.ts`): the land at the leg's own ends, a quay a boat
 * lies alongside, is not crossed; land past it, or after water, is.
 */

const M_PER_DEG_LAT = 111195;
const BOX: Box = [22.0, 60.0, 22.012, 60.006];
const AT: [number, number] = [22.006, 60.003];
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((AT[1] * Math.PI) / 180);
/** The point `x` metres east and `y` metres north of AT. */
const at = (x: number, y = 0): LonLat => [AT[0] + x / M_PER_DEG_LON, AT[1] + y / M_PER_DEG_LAT];
const lon = (x: number): number => at(x)[0];
const ZOOMS = { minZoom: 12, leafZoom: 20, edgeZoom: edgeZoomFor(20) };

const advisory = <F extends ChartFeature>(f: F): F => ({ ...f, advisory: true });

/**
 * A harbour in a cell that charts no land: a basin west of AT, a breakwater `width` metres wide
 * from AT eastward, open water east of it, and the quay, all land, west of 150 m west.
 */
function harbour(width: number) {
  return buildPyramid(
    [
      advisory(coverage(BOX)),
      advisory(quality(BOX, 1)),
      advisory(area([lon(-150), BOX[1], AT[0], BOX[3]], 2)),
      advisory(area([lon(width), BOX[1], BOX[2], BOX[3]], 6))
    ],
    ZOOMS
  );
}

describe("a leg's own line over land", () => {
  const store = harbour(12);

  test("over water alone crosses none", () => {
    expect(crossesLand(store, at(-100), at(-20))).toBe(false);
    expect(crossesLand(store, at(30, -50), at(120, 80))).toBe(false);
  });

  test("across the breakwater crosses it, either way and at any angle", () => {
    expect(crossesLand(store, at(-40), at(50))).toBe(true);
    expect(crossesLand(store, at(50), at(-40))).toBe(true);
    expect(crossesLand(store, at(-40, -70), at(50, 90))).toBe(true);
  });

  test("from a boat alongside the quay, out into the basin, crosses none", () => {
    // 2 m off the quay's face: in the land tile the shore is drawn in.
    expect(crossesLand(store, at(-148), at(-110))).toBe(false);
    expect(crossesLand(store, at(-110), at(-148))).toBe(false);
    expect(crossesLand(store, at(-148), at(-110, 30))).toBe(false);
  });

  test("counts the tiles it visits, for its leg's work, more for a longer line", () => {
    const short = { visits: 0 };
    const long = { visits: 0 };
    crossesLand(store, at(-40), at(50), short);
    crossesLand(store, at(-140), at(150), long);
    expect(short.visits).toBeGreaterThan(0);
    expect(long.visits).toBeGreaterThan(short.visits);
  });

  test("from a point put on the quay's face, within a tile of the water, crosses none", () => {
    expect(crossesLand(store, at(-152), at(-110))).toBe(false);
  });

  test("from a point put on land farther in, the nearest way off it crosses none", () => {
    // 25 m and 110 m in from the quay's face, out to the basin straight east: the nearest water.
    expect(crossesLand(store, at(-175), at(-110))).toBe(false);
    expect(crossesLand(store, at(-260), at(-110))).toBe(false);
    expect(crossesLand(store, at(-110), at(-260))).toBe(false);
  });

  test("from a point put on land, a way over much more land than the nearest way crosses it", () => {
    // 25 m in, but leaving the land 215 m down the quay.
    expect(crossesLand(store, at(-175), at(-140, -300))).toBe(true);
    expect(crossesLand(store, at(-140, -300), at(-175))).toBe(true);
  });

  test("from a boat alongside the breakwater, through it to the water behind, crosses it", () => {
    // 2 m off its inner face, and from the land tile of that face itself.
    expect(crossesLand(store, at(-2), at(40))).toBe(true);
    expect(crossesLand(store, at(1), at(40))).toBe(true);
    expect(crossesLand(store, at(40), at(-2))).toBe(true);
  });

  test("from a boat alongside the breakwater, back into the basin, crosses none", () => {
    expect(crossesLand(store, at(-2), at(-40))).toBe(false);
    expect(crossesLand(store, at(1), at(-40, 25))).toBe(false);
  });

  test("land after water is crossed however near the leg's end it lies", () => {
    // From the basin to a point just past the breakwater: its end lies in water behind it.
    expect(crossesLand(store, at(-10), at(16))).toBe(true);
  });

  test.each([1, 3, 6, 25])(
    "a breakwater %s m wide is crossed from the water beside it",
    (width) => {
      const narrow = harbour(width);
      expect(crossesLand(narrow, at(-12), at(width + 12))).toBe(true);
      expect(crossesLand(narrow, at(-12, -8), at(width + 12, 9))).toBe(true);
    }
  );

  test("a leg across ±180° is taken to cross", () => {
    expect(crossesLand(store, [179.999, 60], [-179.999, 60])).toBe(true);
  });
});

describe("with the index's blocks not loaded", () => {
  // The finer tiles stand in as their parent's bounds: land all over where any lies under it.
  const whole = harbour(12);
  const none = pyramidFromBuffer(serializePyramid(whole), { budgetBytes: Infinity, syncBytes: -1 });

  test("a line that crosses land with them loaded crosses land without", () => {
    const lines: [LonLat, LonLat][] = [
      [at(-40), at(50)],
      [at(-2), at(40)],
      [at(-10), at(16)],
      [at(-175), at(-140, -300)],
      [at(-40, -70), at(50, 90)]
    ];
    expect(lines.map(([a, b]) => crossesLand(whole, a, b))).toEqual(lines.map(() => true));
    expect(lines.map(([a, b]) => crossesLand(none, a, b))).toEqual(lines.map(() => true));
  });

  test("a line over water there is taken to cross: the stand-in holds the land beside it", () => {
    for (const [a, b] of [
      [at(-130), at(-20)],
      [at(-60), at(-40)]
    ] as [LonLat, LonLat][]) {
      expect(crossesLand(whole, a, b)).toBe(false);
      expect(crossesLand(none, a, b)).toBe(true);
    }
  });
});

describe("in a cell that charts its land", () => {
  // Water all over, and a mole 30 m wide drawn as a land area: land a leaf wide around it.
  const store = buildPyramid(
    [coverage(BOX), quality(BOX, 1), area(BOX, 6), land([AT[0], BOX[1], lon(30), BOX[3]])],
    ZOOMS
  );

  test("a line across the mole crosses it, and one off its face does not", () => {
    expect(crossesLand(store, at(-80), at(110))).toBe(true);
    expect(crossesLand(store, at(-3), at(-80))).toBe(false);
    expect(crossesLand(store, at(-120), at(-40))).toBe(false);
  });
});
