import fc from "fast-check";
import { areasCover } from "../../src/foundation/area-cover";
import type { Rect, XY } from "../../src/foundation/geo";
import { fromMercator, tileAt, tileRect, toMercator } from "../../src/foundation/geo";
import type { ChartFeature } from "../../src/ingest/features";
import { edgeZoomFor } from "../../src/spatial/build-items";
import type { NodeStore } from "../../src/spatial/node-store";
import { FLAGS } from "../../src/spatial/node-store";
import { coverAreas, indexPolygon } from "../../src/spatial/polygon-index";
import { minDepthOver } from "../../src/spatial/pyramid";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { COVERED, shoreAt, shoreOf } from "../../src/spatial/shore";
import type { Box } from "../helpers/synthetic";
import { area, coverage, quality } from "../helpers/synthetic";

/**
 * The shore of a cell that charts no land (`shore.ts`, the Traficom WFS): what its depth areas
 * leave open is land however narrow, drawn at the edge zoom, and a seam between two areas is
 * not.
 */

const M_PER_DEG_LAT = 111195;
const BOX: Box = [22.0, 60.0, 22.012, 60.006];
const AT: [number, number] = [22.006, 60.003];
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((AT[1] * Math.PI) / 180);
const east = (m: number): number => AT[0] + m / M_PER_DEG_LON;
const north = (m: number): number => AT[1] + m / M_PER_DEG_LAT;
const LEAF = 20;
const ZOOMS = { minZoom: 12, leafZoom: LEAF, edgeZoom: edgeZoomFor(LEAF) };
/** A z22 tile at 60° N is 4.8 m on a side: a point this far from a shore is past its tiles. */
const PAST_EDGE_TILE = 7;
/** A z20 leaf is 19.1 m on a side, 27 m corner to corner. */
const PAST_LEAF = 28;

const advisory = <F extends ChartFeature>(f: F): F => ({ ...f, advisory: true });

/** A Traficom-like cell over BOX with `areas`: no land objects, no survey quality of its own. */
function cell(areas: ChartFeature[]): ChartFeature[] {
  return [advisory(coverage(BOX)), advisory(quality(BOX, 1)), ...areas.map(advisory)];
}

function depthAt(store: NodeStore, lon: number, lat: number) {
  const r = minDepthOver(store, { type: "point", p: toMercator(lon, lat) });
  return { depth: r.coveredDMin, flags: r.flags };
}

function depthAlong(store: NodeStore, a: [number, number], b: [number, number]): number {
  return minDepthOver(store, { type: "line", coords: [toMercator(...a), toMercator(...b)] })
    .coveredDMin;
}

/** Water charted `west` m west of AT and `eastward` m east of it, `gap` metres apart. */
const sides = (gap: number, west = 0, eastward = 3): ChartFeature[] => [
  area([BOX[0], BOX[1], AT[0], BOX[3]], west),
  area([east(gap), BOX[1], BOX[2], BOX[3]], eastward)
];

describe("land narrower than a tile, in a cell that charts no land", () => {
  test("a breakwater 8 m wide is land, and a line across it crosses land", () => {
    const store = buildPyramid(cell(sides(8)), ZOOMS);
    expect(depthAt(store, east(4), AT[1]).depth).toBe(-Infinity);
    expect(depthAt(store, east(4), AT[1]).flags & FLAGS.NO_DEPTH).toBe(0);
    expect(depthAlong(store, [east(-40), AT[1]], [east(50), AT[1]])).toBe(-Infinity);
    // Diagonally too, and through the tile corners a diagonal passes.
    expect(depthAlong(store, [east(-40), north(-60)], [east(50), north(60)])).toBe(-Infinity);
  });

  test("the water beside it is water past one edge-zoom tile", () => {
    const store = buildPyramid(cell(sides(8, 5, 5)), ZOOMS);
    expect(depthAt(store, east(-PAST_EDGE_TILE), AT[1]).depth).toBe(5);
    expect(depthAt(store, east(8 + PAST_EDGE_TILE), AT[1]).depth).toBe(5);
    expect(depthAlong(store, [east(-40), north(-60)], [east(-PAST_EDGE_TILE), north(60)])).toBe(5);
    expect(depthAlong(store, [east(8 + PAST_EDGE_TILE), north(-60)], [east(50), north(60)])).toBe(
      5
    );
  });

  test("its depth there is the leaf's, the shallowest of all that reaches the leaf", () => {
    const store = buildPyramid(cell(sides(8)), ZOOMS);
    // 0 m west of the breakwater and 3 m east of it: a leaf across it reads 0 m on both sides.
    expect(depthAt(store, east(-PAST_EDGE_TILE), AT[1]).depth).toBe(0);
    expect([0, 3]).toContain(depthAt(store, east(8 + PAST_EDGE_TILE), AT[1]).depth);
    expect(depthAt(store, east(8 + PAST_LEAF), AT[1]).depth).toBe(3);
  });

  test("a build with no edge zoom draws it at the leaf zoom: land still, a leaf wide", () => {
    const store = buildPyramid(cell(sides(8)), { minZoom: 12, leafZoom: LEAF });
    expect(depthAlong(store, [east(-40), AT[1]], [east(50), AT[1]])).toBe(-Infinity);
    expect(depthAt(store, east(4), AT[1]).depth).toBe(-Infinity);
    expect(depthAt(store, east(-PAST_LEAF), AT[1]).depth).toBe(0);
    expect(depthAt(store, east(8 + PAST_LEAF), AT[1]).depth).toBe(3);
  });

  test.each([1, 3, 19, 60])("a gap %s m wide is land right across", (gap) => {
    const store = buildPyramid(cell(sides(gap)), ZOOMS);
    const open: number[] = [];
    for (let m = 0.5; m < gap; m += 0.5) {
      if (depthAt(store, east(m), north(m)).depth !== -Infinity) {
        open.push(m);
      }
    }
    expect(open).toEqual([]);
  });

  test("a skerry the areas leave out, smaller than a leaf, is land", () => {
    // A 6 m by 6 m hole in the middle of 5 m water, drawn as four areas around it.
    const [w, e, s, n] = [east(0), east(6), north(0), north(6)];
    const store = buildPyramid(
      cell([
        area([BOX[0], BOX[1], w, BOX[3]], 5),
        area([e, BOX[1], BOX[2], BOX[3]], 5),
        area([w, BOX[1], e, s], 5),
        area([w, n, e, BOX[3]], 5)
      ]),
      ZOOMS
    );
    expect(depthAt(store, east(3), north(3)).depth).toBe(-Infinity);
    expect(depthAlong(store, [east(-30), north(3)], [east(30), north(3)])).toBe(-Infinity);
    expect(depthAt(store, east(-PAST_EDGE_TILE), north(3)).depth).toBe(5);
    expect(depthAt(store, east(6 + PAST_EDGE_TILE), north(3)).depth).toBe(5);
  });
});

describe("the shore of a cell that charts no land, wherever it lies", () => {
  test("a cell with a compilation scale draws it at the edge zoom, not a leaf wide", () => {
    const scaled = cell(sides(8, 5, 5)).map((f) => ({ ...f, scale: 50_000 }));
    const store = buildPyramid(scaled, ZOOMS);
    expect(depthAt(store, east(4), AT[1]).depth).toBe(-Infinity);
    expect(depthAt(store, east(-PAST_EDGE_TILE), AT[1]).depth).toBe(5);
    expect(depthAt(store, east(8 + PAST_EDGE_TILE), AT[1]).depth).toBe(5);
  });

  test("a lower band's area the leaf leaves out does not close the gap above", () => {
    // Band 5 covers the breakwater's leaf but not the whole tile two zooms up, where a band 3
    // cell all water over the same ground holds the gap.
    const p = toMercator(east(4), AT[1]);
    const up = tileAt(LEAF - 2, p[0], p[1]);
    const leaf = tileAt(LEAF, p[0], p[1]);
    const [r18, r20] = [tileRect(LEAF - 2, up.x, up.y), tileRect(LEAF, leaf.x, leaf.y)];
    const westRoom = r20.minX > r18.minX;
    const cut = westRoom ? (r18.minX + r20.minX) / 2 : (r20.maxX + r18.maxX) / 2;
    const cutLon = fromMercator(cut, p[1])[0];
    const banded: Box = westRoom
      ? [cutLon, BOX[1], BOX[2], BOX[3]]
      : [BOX[0], BOX[1], cutLon, BOX[3]];
    const low = { cellRef: 1, band: 3 };
    const store = buildPyramid(
      [
        advisory(coverage(banded)),
        advisory(quality(banded, 1)),
        ...sides(8, 5, 5).map(advisory),
        advisory(coverage(BOX, low)),
        advisory(area(BOX, 5, low))
      ],
      ZOOMS
    );
    expect(depthAt(store, east(4), AT[1]).depth).toBe(-Infinity);
  });

  test("its land is land beyond the buffer too, not the depth the areas drew", () => {
    const drawn = cell(sides(8, 5, 5)).map((f) =>
      f.role === "depth" ? { ...f, topoSigma: 5 } : f
    );
    const store = buildPyramid(drawn, ZOOMS);
    const p = toMercator(east(4), AT[1]);
    const { x, y } = tileAt(ZOOMS.edgeZoom, p[0], p[1]);
    const i = store.find(ZOOMS.edgeZoom, x, y);
    expect(store.values(i).dMin).toBe(-Infinity);
    expect(store.topoDMinOf(i)).toBe(-Infinity);
  });

  test("areas that run to ±180° are no shore along it", () => {
    // Two areas meeting at a seam 3 m west of 180°, inside the edge-zoom tile on it.
    const seam = 180 - 3 / M_PER_DEG_LON;
    const store = buildPyramid(
      [
        advisory(coverage([179.988, 60.0, 180, 60.006])),
        advisory(quality([179.988, 60.0, 180, 60.006], 1)),
        advisory(area([179.988, 60.0, seam, 60.006], 5)),
        advisory(area([seam, 60.0, 180, 60.006], 5))
      ],
      ZOOMS
    );
    expect(depthAt(store, 180 - 1 / M_PER_DEG_LON, 60.003).depth).toBe(5);
  });
});

describe("a seam between two depth areas is not land", () => {
  /** No land anywhere along the seam at AT's longitude. */
  function seamIsWater(areas: ChartFeature[]): void {
    const store = buildPyramid(cell(areas), ZOOMS);
    const land: number[] = [];
    for (let m = -250; m <= 250; m += 2.5) {
      if (depthAt(store, AT[0], north(m)).depth === -Infinity) {
        land.push(m);
      }
    }
    expect(land).toEqual([]);
    expect(depthAlong(store, [east(-40), north(-60)], [east(50), north(60)])).toBe(0);
  }

  test("drawn with the same vertices on both sides", () => {
    seamIsWater(sides(0));
  });

  test("drawn with other vertices on one side", () => {
    const [w, s, e, n] = [AT[0], BOX[1], BOX[2], BOX[3]];
    const split: ChartFeature = {
      ...area([w, s, e, n], 3),
      geom: {
        type: "polygon",
        polygons: [
          {
            outer: [
              toMercator(w, s),
              toMercator(e, s),
              toMercator(e, n),
              toMercator(w, n),
              toMercator(w, north(31)),
              toMercator(w, north(-17))
            ],
            holes: []
          }
        ]
      }
    };
    seamIsWater([area([BOX[0], s, AT[0], n], 0), split]);
  });

  test("0.1 m apart, within the seam tolerance", () => {
    seamIsWater(sides(0.1));
  });

  test("an area laid over another, as a dredged channel over its depth area", () => {
    const store = buildPyramid(
      cell([area(BOX, 3), area([east(-20), BOX[1], east(20), BOX[3]], 2.7, { dredged: true })]),
      ZOOMS
    );
    const land: number[] = [];
    for (let m = -60; m <= 60; m += 1.5) {
      if (depthAt(store, east(m), north(m)).depth === -Infinity) {
        land.push(m);
      }
    }
    expect(land).toEqual([]);
  });
});

/** A chart of squares of SIDE metres, INSET from BOX's south-west corner: each water or left out. */
const SIDE = 30;
const INSET = 90;
const lonOf = (x: number): number => BOX[0] + (INSET + x) / M_PER_DEG_LON;
const latOf = (y: number): number => BOX[1] + (INSET + y) / M_PER_DEG_LAT;
const gridOf = (water: boolean[][]): ChartFeature[] =>
  water.flatMap((row, j) =>
    row.flatMap((wet, i) => {
      const box: Box = [
        lonOf(i * SIDE),
        latOf(j * SIDE),
        lonOf((i + 1) * SIDE),
        latOf((j + 1) * SIDE)
      ];
      return wet ? [area(box, 2 + ((i + j) % 3))] : [];
    })
  );

describe("every point no depth area holds is land", () => {
  test("on charts of squares, each water or left out: land in the gaps, water past their tiles", () => {
    const COLS = 8;
    const ROWS = 6;
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.boolean(), { minLength: COLS, maxLength: COLS }), {
          minLength: ROWS,
          maxLength: ROWS
        }),
        fc.array(
          fc.tuple(
            fc.double({ min: 0, max: 1, noNaN: true }),
            fc.double({ min: 0, max: 1, noNaN: true })
          ),
          {
            minLength: 40,
            maxLength: 40
          }
        ),
        (water, points) => {
          const store = buildPyramid(cell(gridOf(water)), ZOOMS);
          const wrong: string[] = [];
          for (const [u, v] of points) {
            const x = u * COLS * SIDE;
            const y = v * ROWS * SIDE;
            const wet = (i: number, j: number): boolean => water[j]?.[i] === true;
            const [i, j] = [Math.floor(x / SIDE), Math.floor(y / SIDE)];
            const { depth } = depthAt(store, lonOf(x), latOf(y));
            // Past an edge-zoom tile from every square left out, and from the squares' edge.
            const [fx, fy] = [x - i * SIDE, y - j * SIDE];
            const near = (d: number, k: number): number[] =>
              d < PAST_EDGE_TILE ? [k - 1, k] : d > SIDE - PAST_EDGE_TILE ? [k, k + 1] : [k];
            const clear = near(fx, i).every((a) => near(fy, j).every((b) => wet(a, b)));
            if (!wet(i, j) && depth !== -Infinity) {
              // -Infinity is land; a depth here would be water where no area is.
              wrong.push(`water at ${x.toFixed(1)}, ${y.toFixed(1)} in a square left out`);
            }
            if (clear && depth === -Infinity) {
              wrong.push(`land at ${x.toFixed(1)}, ${y.toFixed(1)}, clear of every gap`);
            }
          }
          expect(wrong).toEqual([]);
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe("shoreAt answers as areasCover", () => {
  const square = (x: number, y: number, w: number, h: number) =>
    indexPolygon({
      outer: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h]
      ] as XY[],
      holes: []
    });
  const rectOf = (x: number, y: number, w: number, h: number): Rect => ({
    minX: x,
    minY: y,
    maxX: x + w,
    maxY: y + h
  });
  // Squares on a 4 m lattice meet along whole edges, overlap or leave gaps; tiles lie off it.
  const squares = fc.array(
    fc.tuple(
      fc.integer({ min: 0, max: 6 }),
      fc.integer({ min: 0, max: 6 }),
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 1, max: 3 })
    ),
    { minLength: 1, maxLength: 7 }
  );
  const tile = fc.tuple(
    fc.double({ min: -2, max: 30, noNaN: true }),
    fc.double({ min: -2, max: 30, noNaN: true }),
    fc.double({ min: 0.5, max: 9, noNaN: true })
  );

  test("over the tile the edges were gathered in, and over a tile inside it", () => {
    fc.assert(
      fc.property(
        squares,
        tile,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (boxes, [x, y, size], part) => {
          const polys = boxes.map(([i, j, w, h]) => square(4 * i, 4 * j, 4 * w, 4 * h));
          const covers = (r: Rect): boolean => areasCover(coverAreas(polys), r);
          const whole = rectOf(x, y, size, size);
          const shore = shoreOf(polys, whole);
          const inner = rectOf(x + (part * size) / 2, y + (part * size) / 2, size / 2, size / 2);
          expect([whole, inner].map((r) => shoreAt(shore, r, covers) === COVERED)).toEqual(
            [whole, inner].map(covers)
          );
        }
      ),
      { numRuns: 2000 }
    );
  });
});
