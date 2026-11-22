import type { WfsFeature } from "./wfs-fetch";
import { num } from "./wfs-fetch";

/**
 * Gaps in a swept fairway (plan §4.11, swept fairways). The FTIA leaves a fairway's swept areas
 * off where a bridge spans it: at Lillholmen, Pargas, its boat route 3530 is swept to 2.7 m on
 * both sides of the bridge, about 36 m wide, and nothing is published for the 70 m under it,
 * where the Traficom WFS charts the 0–3 m band of the banks. The fairway's navigation line runs
 * on through the gap with its own safe clearance depth (`haraussyvyys`), the depth the fairway
 * authority keeps the line clear to and answers for, from the same reference level as the
 * areas. Where one line leaves a swept area and enters another within GAP_MAX metres, the gap is
 * given a strip along the line, as wide each side as the narrower of the two areas where the line
 * leaves and enters them and at most HALF_MAX metres (a bridge's opening may be narrower than the
 * fairway), at the line's safe clearance depth or the areas' swept depth, whichever is less:
 * never more than was swept on either side. A line without a safe clearance depth gives its
 * design draft (`mitoitussyvays`) instead, the static draft of the vessel it is laid out for,
 * which is less than the depth by the gross under-keel clearance (0.2–0.6 m on a boat route,
 * Traficom's depth instructions). Like the swept areas, the cell holds the strip as a guaranteed
 * depth (SWPARE beside DRGARE, `wfs.ts`). It reaches OVERLAP samples into each area it joins,
 * where the least depth of the two holds (`spatial/give-way.ts`): at the swept depth of the area
 * it never lowers it, so a strip at the design draft would.
 */

/** The longest gap along a line that is bridged, metres. */
export const GAP_MAX = 150;
/** The widest a strip reaches either side of its line, metres. */
export const HALF_MAX = 10;
/** Sampling step along a line, metres. */
const STEP = 2;
/**
 * Samples a strip reaches back into each area it joins: an area's end across the fairway may be
 * cut on the slant, and a leg's corridor at the line's last point inside it reaches past that end.
 */
const OVERLAP = Math.ceil(10 / 2);
/** How far a cross-section looks for an area's edge, metres. */
const REACH = 100;

type XY = [number, number];

interface Area {
  id: string;
  depth: number;
  /** Outer rings and holes, in the local plane. */
  polygons: XY[][][];
}

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** A local plane at `origin`: metres east and north. */
function planeAt(origin: XY): { to(p: XY): XY; from(p: XY): XY } {
  const k = Math.cos(origin[1] * RAD) * R * RAD;
  return {
    to: (p) => [(p[0] - origin[0]) * k, (p[1] - origin[1]) * R * RAD],
    from: (p) => [origin[0] + p[0] / k, origin[1] + p[1] / (R * RAD)]
  };
}

function inRing(p: XY, ring: XY[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as XY;
    const [xj, yj] = ring[j] as XY;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      c = !c;
    }
  }
  return c;
}

const inArea = (p: XY, a: Area): boolean =>
  a.polygons.some(
    (rings) => inRing(p, rings[0] as XY[]) && !rings.slice(1).some((h) => inRing(p, h))
  );

/**
 * Distance from `p` along unit `v` to the first edge of `a`, or Infinity within REACH. A `p` on
 * an edge is 0 from it: a line along an area's edge has no width of it on that side.
 */
function toEdge(p: XY, v: XY, a: Area): number {
  let best = Infinity;
  for (const rings of a.polygons) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j] as XY;
        const [bx, by] = ring[i] as XY;
        const ex = bx - ax;
        const ey = by - ay;
        const den = v[0] * ey - v[1] * ex;
        if (Math.abs(den) < 1e-12) {
          continue;
        }
        const t = ((ax - p[0]) * ey - (ay - p[1]) * ex) / den;
        const u = ((ax - p[0]) * v[1] - (ay - p[1]) * v[0]) / den;
        if (t >= 0 && t <= REACH && u >= 0 && u <= 1) {
          best = Math.min(best, t);
        }
      }
    }
  }
  return best;
}

function polygonsOf(g: WfsFeature["geometry"]): XY[][][] {
  if (g?.type === "Polygon") {
    return [g.coordinates as XY[][]];
  }
  return g?.type === "MultiPolygon" ? (g.coordinates as XY[][][]) : [];
}

function linePartsOf(g: WfsFeature["geometry"]): XY[][] {
  if (g?.type === "LineString") {
    return [g.coordinates as XY[]];
  }
  return g?.type === "MultiLineString" ? (g.coordinates as XY[][]) : [];
}

interface Sample {
  p: XY;
  /** Unit direction along the line here. */
  t: XY;
  /** Every area holding the point. */
  areas: number[];
  /** The least swept depth of the areas holding the point; Infinity in none. */
  depth: number;
  along: number;
}

/** Points every STEP metres along `line`, with the area holding each. */
function samplesOf(line: XY[], areas: Area[]): Sample[] {
  const out: Sample[] = [];
  let along = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as XY;
    const b = line[i] as XY;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) {
      continue;
    }
    const t: XY = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    for (let s = 0; s < len; s += STEP) {
      const p: XY = [a[0] + t[0] * s, a[1] + t[1] * s];
      const holding = areas.flatMap((x, k) => (inArea(p, x) ? [k] : []));
      out.push({
        p,
        t,
        areas: holding,
        depth: Math.min(...holding.map((k) => (areas[k] as Area).depth)),
        along: along + s
      });
    }
    along += len;
  }
  return out;
}

/** How far into an area before or after its gap its width is taken, metres. */
const BACK = 20;

/** Half-widths of area `a` left and right of the line at `s`, capped at HALF_MAX. */
function halves(s: Sample, a: Area): [number, number] {
  const left: XY = [-s.t[1], s.t[0]];
  const right: XY = [s.t[1], -s.t[0]];
  return [Math.min(HALF_MAX, toEdge(s.p, left, a)), Math.min(HALF_MAX, toEdge(s.p, right, a))];
}

/**
 * The widest half-widths of area `area` over the samples within BACK metres of `at`: an area's
 * end across the fairway may be cut on the slant, so the last sample's cross-section meets it.
 * A side where `at` lies on the area's edge stays 0: the samples further in reach past that edge
 * once the strip runs on from `at`.
 */
function widest(samples: Sample[], at: Sample, area: number, areas: Area[]): [number, number] {
  const own = halves(at, areas[area] as Area);
  let best = own;
  for (const s of samples) {
    if (s.areas.includes(area) && Math.abs(s.along - at.along) <= BACK) {
      const h = halves(s, areas[area] as Area);
      best = [Math.max(best[0], h[0]), Math.max(best[1], h[1])];
    }
  }
  return [own[0] === 0 ? 0 : best[0], own[1] === 0 ? 0 : best[1]];
}

/** The strip from sample `from` to sample `to` along `run`, left and right `half` metres. */
function strip(run: Sample[], half: [number, number]): XY[] {
  const left = run.map((s) => [s.p[0] - s.t[1] * half[0], s.p[1] + s.t[0] * half[0]] as XY);
  const right = run.map((s) => [s.p[0] + s.t[1] * half[1], s.p[1] - s.t[0] * half[1]] as XY);
  const ring = [...left, ...right.reverse()];
  return [...ring, ring[0] as XY];
}

/**
 * The strips bridging the gaps of the swept areas `swept` (dredged areas, DRVAL1 their swept
 * depth) along the navigation lines `lines` (with `haraussyvyys`, else `mitoitussyvays`), as
 * dredged areas.
 */
export function fairwayGaps(
  lines: readonly WfsFeature[],
  swept: readonly WfsFeature[]
): WfsFeature[] {
  const first = swept.flatMap((f) => polygonsOf(f.geometry))[0]?.[0]?.[0];
  if (!first) {
    return [];
  }
  const plane = planeAt(first);
  const areas: Area[] = swept.map((f) => ({
    id: String(f.properties?.IDENTIFIER ?? ""),
    depth: num(f.properties?.DRVAL1) ?? 0,
    polygons: polygonsOf(f.geometry).map((rings) => rings.map((r) => r.map((p) => plane.to(p))))
  }));
  const out: WfsFeature[] = [];
  for (const line of lines) {
    // The safe clearance depth the line is kept to, else the draft it is laid out for.
    const kept = num(line.properties?.haraussyvyys) ?? num(line.properties?.mitoitussyvays);
    if (kept === undefined || kept <= 0) {
      continue;
    }
    for (const part of linePartsOf(line.geometry)) {
      const samples = samplesOf(
        part.map((p) => plane.to(p)),
        areas
      );
      out.push(...gapsAlong(samples, areas, kept, plane.from));
    }
  }
  return out;
}

/**
 * The gaps along one line's samples: runs outside every area between two areas. A run that
 * leaves an area and comes back into it crosses a hole or a part the FTIA left out of it, also
 * where another area overlaps it at either end.
 */
function gapsAlong(
  samples: Sample[],
  areas: Area[],
  kept: number,
  from: (p: XY) => XY
): WfsFeature[] {
  const out: WfsFeature[] = [];
  let i = 0;
  while (i < samples.length) {
    if ((samples[i] as Sample).areas.length > 0 || i === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < samples.length && (samples[j] as Sample).areas.length === 0) {
      j++;
    }
    const before = samples[i - 1] as Sample;
    const after = samples[j];
    const [ka, kb] = [before.areas[0], after?.areas[0]];
    const between =
      after &&
      ka !== undefined &&
      kb !== undefined &&
      !after.areas.some((k) => before.areas.includes(k));
    if (between && after.along - before.along <= GAP_MAX) {
      const a = areas[ka] as Area;
      const b = areas[kb] as Area;
      const [al, ar] = widest(samples, before, ka, areas);
      const [bl, br] = widest(samples, after, kb, areas);
      const half: [number, number] = [Math.min(al, bl), Math.min(ar, br)];
      if (half[0] > 0 && half[1] > 0 && Number.isFinite(half[0] + half[1])) {
        out.push({
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              strip(samples.slice(Math.max(0, i - 1 - OVERLAP), j + 1 + OVERLAP), half).map(from)
            ]
          },
          properties: {
            DRVAL1: Math.min(kept, before.depth, after.depth),
            IDENTIFIER: `FTIA-GAP-${a.id}-${b.id}`
          }
        });
      }
    }
    i = j;
  }
  return out;
}
