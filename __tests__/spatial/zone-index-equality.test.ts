import fc from "fast-check";
import type { Rect, XY } from "../../src/foundation/geo";
import {
  emptyRect,
  expandRect,
  fromMercator,
  rectsOverlap,
  toMercator
} from "../../src/foundation/geo";
import { areasCover, areasCoverRect } from "../../src/foundation/area-cover";
import type { Geom, PolygonGeom } from "../../src/foundation/geometry";
import { geomBounds, geomRectDistance } from "../../src/foundation/geometry";
import type { Catzoc, ChartFeature, DepthFeature, QualityFeature } from "../../src/ingest/features";
import type { BuildOptions } from "../../src/spatial/build-items";
import { cellReach, DEFAULT_BUILD, prepareItems } from "../../src/spatial/build-items";
import { coverAreas, indexPolygon } from "../../src/spatial/polygon-index";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { sigmaFor } from "../../src/spatial/quality";
import { serializePyramid } from "../../src/spatial/store";
import { fraction } from "../helpers/arbitraries";
import { areasCoverRect as walkedCover } from "../helpers/reference-area-cover";
import { referenceBuildPyramid } from "../helpers/reference-pyramid-build";
import { area, coverage, point } from "../helpers/synthetic";

/**
 * The indexed quality-zone tests are an exact speed-up: every burn radius and
 * every tile's coverage decision equals the walk over every zone and edge.
 */

const CENTRE = toMercator(22.005, 60.005);

/**
 * Two areas meeting along a random polyline across a 100-unit square, the
 * upper one moved `shift` units and, when `thin`, drawn with every other seam
 * vertex; the lower one may hold a many-vertex hole, and a third area with a
 * hole may overlap both. With up to 150 seam vertices the rings are walked
 * whole or through the edge grid.
 */
interface Seam {
  polys: PolygonGeom[];
  vertices: XY[];
}

const seamArb = (shifts: number[]) =>
  fc
    .record({
      xs: fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { maxLength: 150 }),
      ys: fc.array(fc.integer({ min: 50, max: 950 }), { minLength: 152, maxLength: 152 }),
      shift: fc.constantFrom(...shifts),
      thin: fc.boolean(),
      hole: fc.option(fc.integer({ min: 3, max: 90 }), { nil: undefined }),
      third: fc.boolean()
    })
    .map(({ xs, ys, shift, thin, hole, third }): Seam => {
      const line = [0, ...xs.sort((a, b) => a - b), 1000].map((x, i): XY => [
        x / 10,
        (ys[i] as number) / 10
      ]);
      const moved = line
        .filter((_, i) => !thin || i % 2 === 0 || i === line.length - 1)
        .map(([x, y]): XY => [x, y + shift]);
      const star = (cx: number, cy: number, r: number, n: number): XY[] =>
        Array.from({ length: n }, (_, i): XY => {
          const a = (2 * Math.PI * i) / n;
          return [cx + r * (0.6 + 0.4 * ((i * 7) % 3)) * Math.cos(a), cy + r * Math.sin(a)];
        });
      const polys: PolygonGeom[] = [
        {
          outer: [[0, 0], [100, 0], ...[...line].reverse()],
          holes: hole === undefined ? [] : [star(40, 2.5, 1.4, hole)]
        },
        { outer: [...moved, [100, 100], [0, 100]], holes: [] }
      ];
      if (third) {
        const sq = (a: number, b: number): XY[] => [
          [a, a],
          [b, a],
          [b, b],
          [a, b]
        ];
        polys.push({ outer: sq(30, 70), holes: [sq(45, 55)] });
      }
      const vertices = polys.flatMap((p) => [...p.outer, ...p.holes.flat()]);
      return { polys, vertices };
    });

/** The seam `s` units wide per local unit, its origin at `o`. */
function place(seam: Seam, o: XY, s: number): Seam {
  const at = ([x, y]: XY): XY => [o[0] + x * s, o[1] + y * s];
  return {
    polys: seam.polys.map((p) => ({
      outer: p.outer.map(at),
      holes: p.holes.map((h) => h.map(at))
    })),
    vertices: seam.vertices.map(at)
  };
}

/** Rectangles and points on the vertices, on edge midpoints and around them. */
function rectsAround(seam: Seam, picks: number[], s: number): Rect[] {
  const edges = seam.polys.flatMap((p) =>
    [p.outer, ...p.holes].flatMap((ring) =>
      ring.map((a, i): [XY, XY] => [a, ring[(i + 1) % ring.length] as XY])
    )
  );
  const pick = <T>(list: T[], f: number): T =>
    list[Math.min(list.length - 1, Math.floor(f * list.length))] as T;
  return picks.flatMap((f, k) => {
    const v = pick(seam.vertices, f);
    const [a, b] = pick(edges, (f * 7.3) % 1);
    const m: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const w = s * (0.05 + 30 * ((f * 13.7) % 1));
    const free: XY = [
      (seam.vertices[0] as XY)[0] + ((f * 3.1) % 1) * 100 * s,
      (seam.vertices[0] as XY)[1] + f * 100 * s
    ];
    const at = (p: XY, dx: number, dy: number): Rect => ({
      minX: p[0] - dx * w,
      minY: p[1] - dy * w,
      maxX: p[0] + (1 - dx) * w,
      maxY: p[1] + (1 - dy) * w
    });
    const corner = k % 4;
    return [
      { minX: v[0], minY: v[1], maxX: v[0], maxY: v[1] },
      { minX: m[0], minY: m[1], maxX: m[0], maxY: m[1] },
      at(v, corner & 1, corner >> 1),
      at(m, 0.5, 0.5),
      at(free, 0, 0)
    ];
  });
}

const placement = fc.constantFrom<[XY, number]>([[0, 0], 1], [CENTRE, 1], [CENTRE, 2.5]);

describe("indexed coverage equals the walk over every edge", () => {
  test("seams split alike and not, gaps, overlaps, holes; rects on vertices and edges", () => {
    fc.assert(
      fc.property(
        // Units of the seam's own placement scale, so gaps of 0.4 and 0.6 straddle SEAM_TOLERANCE.
        seamArb([0, 0, 0.1, -0.2, 0.4, -0.6, 2]),
        placement,
        fc.array(fraction, { minLength: 4, maxLength: 16 }),
        fc.boolean(),
        (local, [o, s], picks, joined) => {
          const seam = place(local, o, s);
          const geoms: Geom[] = joined
            ? [{ type: "polygon", polygons: seam.polys }]
            : seam.polys.map((p) => ({ type: "polygon", polygons: [p] }));
          const indexed = coverAreas(seam.polys.map(indexPolygon));
          const bad: Array<{ r: Rect; want: boolean; walked: boolean; index: boolean }> = [];
          for (const r of rectsAround(seam, picks, s)) {
            const want = walkedCover(geoms, r);
            const walked = areasCoverRect(geoms, r);
            const index = areasCover(indexed, r);
            if (walked !== want || index !== want) {
              bad.push({ r, want, walked, index });
            }
          }
          // One assertion per run, not per rect (§7 Test runtime).
          expect(bad).toEqual([]);
        }
      ),
      { numRuns: 200 }
    );
  });
});

/** build-items.ts `reaches` before the zone grid: every zone of the point's cell tested whole. */
function walkedRadii(
  features: ChartFeature[],
  opts: BuildOptions,
  keep?: (bbox: Rect, radius: number) => boolean
): (number | undefined)[] {
  const burns = (f: ChartFeature): boolean =>
    f.role === "depth" && f.hazard === true && f.geom.type === "point";
  const unassessedSigma = sigmaFor(undefined, 0, {}, opts.quality).sigmaP;
  const zones = (cellRef: number) =>
    features
      .filter((f): f is QualityFeature => f.role === "quality" && f.cellRef === cellRef)
      .map((q) => ({
        q,
        bbox: geomBounds(q.geom),
        sigmaP: sigmaFor(q.catzoc, 0, q, opts.quality).sigmaP
      }));
  return features.map((f) => {
    const bbox = geomBounds(f.geom);
    const own = zones(f.cellRef);
    const widest = opts.k * own.reduce((m, z) => Math.max(m, z.sigmaP), unassessedSigma);
    if (keep && !keep(bbox, burns(f) ? widest : 0)) {
      return undefined;
    }
    let radius = 0;
    if (burns(f)) {
      let sigmaP = 0;
      let covered = false;
      let unassessed = false;
      for (const z of own) {
        if (rectsOverlap(z.bbox, bbox) && geomRectDistance(z.q.geom, bbox, 0) === 0) {
          covered = true;
          unassessed ||= z.q.catzoc === 6 || z.q.advisory === true;
          sigmaP = Math.max(sigmaP, z.sigmaP);
        }
      }
      radius = covered && !unassessed ? 0 : opts.k * (covered ? sigmaP : unassessedSigma);
    }
    return keep && !keep(bbox, radius) ? undefined : radius;
  });
}

const zoneArb = fc.record({
  catzoc: fc.constantFrom<Catzoc>(1, 2, 3, 4, 5, 6),
  advisory: fc.boolean(),
  cellRef: fc.integer({ min: 0, max: 1 })
});

function zonesOf(
  seam: Seam,
  kinds: { catzoc: Catzoc; advisory: boolean; cellRef: number }[]
): QualityFeature[] {
  return seam.polys.map((p, i) => {
    const kind = kinds[i % kinds.length] as (typeof kinds)[number];
    return {
      role: "quality",
      objectClass: "M_QUAL",
      geom: { type: "polygon", polygons: [p] },
      catzoc: kind.catzoc,
      advisory: kind.advisory || undefined,
      cellRef: kind.cellRef,
      band: 5
    };
  });
}

function sounding(p: XY, cellRef: number): DepthFeature {
  return {
    role: "depth",
    objectClass: "SOUNDG",
    geom: { type: "point", p },
    depth: 3,
    hazard: true,
    dredged: false,
    cellRef,
    band: 5
  };
}

describe("burn radii equal the zone-by-zone test", () => {
  test("points on vertices, edge midpoints, in holes and seams, and outside every zone", () => {
    fc.assert(
      fc.property(
        seamArb([0, 0, 0.1, -0.2, 2]),
        placement,
        fc.array(zoneArb, { minLength: 1, maxLength: 3 }),
        fc.array(fc.tuple(fraction, fraction, fc.integer({ min: 0, max: 1 })), { maxLength: 30 }),
        fraction,
        (local, [o, s], kinds, at, cut) => {
          const seam = place(local, o, s);
          const zones = zonesOf(seam, kinds);
          const onSeam = seam.polys.flatMap((p) =>
            [p.outer, ...p.holes].flatMap((ring) =>
              ring.flatMap((a, i): XY[] => {
                const b = ring[(i + 1) % ring.length] as XY;
                return [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]];
              })
            )
          );
          const points = [
            ...onSeam.filter((_, i) => i % 3 === 0).map((p, i) => sounding(p, i % 2)),
            ...at.map(([u, v, c]) =>
              sounding([o[0] + (u * 120 - 10) * s, o[1] + (v * 120 - 10) * s], c)
            )
          ];
          const features: ChartFeature[] = [...zones, ...points];
          const opts = DEFAULT_BUILD;
          const want = walkedRadii(features, opts);
          const got = prepareItems(features, opts).map((item) => item.radius);
          // A window over part of the seam, as a region build keeps the features reaching it.
          const window: Rect = {
            minX: o[0],
            minY: o[1],
            maxX: o[0] + 100 * s * cut,
            maxY: o[1] + 100 * s
          };
          const keep = (bbox: Rect, radius: number) =>
            rectsOverlap(expandRect(window, radius), bbox);
          const wantKept = walkedRadii(features, opts, keep)
            .map((r, i) => [i, r])
            .filter(([, r]) => r !== undefined);
          const gotKept = prepareItems(features, opts, keep).map((item) => [
            features.indexOf(item.f),
            item.radius
          ]);
          const reach = cellReach(features, opts).radius;
          const wantReach = Math.max(0, ...(want as number[]));
          expect({ got, gotKept, reach }).toEqual({
            got: want,
            gotKept: wantKept,
            reach: wantReach
          });
        }
      ),
      { numRuns: 150 }
    );
  });
});

describe("a build over seamed quality zones equals the reference builder", () => {
  test("zones meeting, apart and overlapping, with soundings on and off their edges", () => {
    // 2.5 Mercator metres per seam unit: some 125 m of ground across at 60° N.
    const s = 2.5;
    const [lon0, lat0] = fromMercator(CENTRE[0] - 20 * s, CENTRE[1] - 20 * s);
    const [lon1, lat1] = fromMercator(CENTRE[0] + 120 * s, CENTRE[1] + 120 * s);
    const box = [lon0, lat0, lon1, lat1] as const;
    fc.assert(
      fc.property(
        seamArb([0, 0, 0.1, -0.2, 2]),
        fc.array(zoneArb, { minLength: 1, maxLength: 3 }),
        fc.array(fc.tuple(fraction, fraction, fc.integer({ min: 0, max: 12 })), { maxLength: 12 }),
        (local, kinds, at) => {
          const seam = place(local, CENTRE, s);
          const zones = zonesOf(
            seam,
            kinds.map((k) => ({ ...k, cellRef: 0 }))
          );
          const features: ChartFeature[] = [
            coverage(box),
            area(box, 25),
            ...zones,
            ...seam.vertices.filter((_, i) => i % 9 === 0).map((p) => sounding(p, 0)),
            ...at.map(([u, v, d]) => point(lon0 + u * (lon1 - lon0), lat0 + v * (lat1 - lat0), d))
          ];
          const opts = { minZoom: 12, leafZoom: 20 };
          expect(
            serializePyramid(buildPyramid(features, opts)).equals(
              serializePyramid(referenceBuildPyramid(features, opts))
            )
          ).toBe(true);
        }
      ),
      { numRuns: 20 }
    );
  });
});

test("an empty quality zone overlaps nothing", () => {
  const empty: QualityFeature = {
    role: "quality",
    objectClass: "M_QUAL",
    geom: { type: "polygon", polygons: [] },
    catzoc: 1,
    cellRef: 0,
    band: 5
  };
  const features: ChartFeature[] = [empty, sounding(CENTRE, 0)];
  expect(geomBounds(empty.geom)).toEqual(emptyRect());
  expect(prepareItems(features, DEFAULT_BUILD).map((i) => i.radius)).toEqual(
    walkedRadii(features, DEFAULT_BUILD)
  );
});
