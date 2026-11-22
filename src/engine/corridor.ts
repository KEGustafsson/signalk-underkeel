import type { LonLat } from "../foundation/geo";
import { fromMercator, haversine, offset, project, toMercator, wrapLon } from "../foundation/geo";

/**
 * A leg's corridor as the route check queries it (plan §4.11): rings along the rhumb line and,
 * where they part, the great circle, each piece widened to hold every point within the
 * corridor half-width of both.
 */

/**
 * Long legs are checked in pieces at least this long, and at least four
 * corridor half-widths: each piece reaches r past both ends, so shorter
 * pieces of a wide corridor would query the same water several times.
 */
const SEGMENT_METRES = 1000;

/** b moved by whole turns of longitude to within 180° of a: the short way round. */
function nearSide(a: LonLat, b: LonLat): LonLat {
  return [a[0] + wrapLon(b[0] - a[0]), b[1]];
}

/** The rhumb line's course from a to b, as the chart draws the leg, degrees true 0..360. */
export function rhumbCourse(a: LonLat, b: LonLat): number {
  const [ax, ay] = toMercator(a[0], a[1]);
  const [bx, by] = toMercator(nearSide(a, b)[0], b[1]);
  return ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360;
}

/** True bearing from a to b in the tangent plane at a that `project` offsets in, radians. */
export function bearing(a: LonLat, b: LonLat): number {
  const east = (nearSide(a, b)[0] - a[0]) / (offset(a, 1, 0)[0] - a[0]);
  const north = (b[1] - a[1]) / (offset(a, 0, 1)[1] - a[1]);
  return Math.atan2(east, north);
}

/**
 * Relative widening of every ring. Over a piece the Mercator chart and the
 * tangent plane at its start drift apart: a ring exactly r wide missed
 * points r off the rhumb line by up to 0.15 % of r (measured up to 84°,
 * pieces up to 4r long).
 */
const RING_SLACK = 1 / 256;
/**
 * How far a corridor ring reaches from the leg's end, in half-widths: its corners lie a
 * slackened half-width past the end and to the side, so √2 of it away.
 */
export const RING_REACH = Math.SQRT2 * (1 + RING_SLACK);

/**
 * Rectangle around segment a→b, `r` metres to each side and past each
 * end. It contains the capsule buffer(a→b, r) around the segment drawn
 * straight on the chart, so the check is never narrower than the corridor.
 * Across ±180° the ring keeps a's side and reaches past it.
 */
export function corridorRing(a: LonLat, b: LonLat, rMetres: number): LonLat[] {
  const brg = bearing(a, b);
  const r = rMetres * (1 + RING_SLACK);
  const start = project(a, brg + Math.PI, r);
  const end = project(nearSide(a, b), brg, r);
  return [
    project(end, brg + Math.PI / 2, r),
    project(start, brg + Math.PI / 2, r),
    project(start, brg - Math.PI / 2, r),
    project(end, brg - Math.PI / 2, r)
  ];
}

/** The point `t` of the way along the rhumb line a→b, the line drawn straight on the chart. */
export function alongRhumb(a: LonLat, b: LonLat, t: number): LonLat {
  const near = nearSide(a, b);
  const [ax, ay] = toMercator(a[0], a[1]);
  const [bx, by] = toMercator(near[0], near[1]);
  const p = fromMercator(ax + (bx - ax) * t, ay + (by - ay) * t);
  return [wrapLon(p[0]), p[1]];
}

function unitVector(p: LonLat): [number, number, number] {
  const k = Math.PI / 180;
  const c = Math.cos(p[1] * k);
  return [c * Math.cos(p[0] * k), c * Math.sin(p[0] * k), Math.sin(p[1] * k)];
}

/** The point `t` of the way along the great circle a→b, the line a navigator steering it follows. */
function alongGreatCircle(a: LonLat, b: LonLat, t: number): LonLat {
  const va = unitVector(a);
  const vb = unitVector(b);
  const omega = Math.acos(Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  if (omega === 0) {
    return a;
  }
  const wa = Math.sin((1 - t) * omega) / Math.sin(omega);
  const wb = Math.sin(t * omega) / Math.sin(omega);
  const [x, y, z] = va.map((c, i) => wa * c + wb * (vb[i] as number)) as [number, number, number];
  const deg = 180 / Math.PI;
  return [Math.atan2(y, x) * deg, Math.atan2(z, Math.hypot(x, y)) * deg];
}

/** Upper bound of the gap between a leg's rhumb line and its great circle, metres. */
export function greatCircleOffset(a: LonLat, b: LonLat): number {
  let gap = 0;
  for (let i = 1; i < 8; i++) {
    gap = Math.max(gap, haversine(alongRhumb(a, b, i / 8), alongGreatCircle(a, b, i / 8)));
  }
  return gap;
}

/**
 * Below this gap, or a quarter of the corridor half-width, the rhumb
 * corridor is widened by the gap; above, the great circle gets its own.
 */
const GREAT_CIRCLE_TOLERANCE = 10;

type Line = (a: LonLat, b: LonLat, t: number) => LonLat;

/**
 * How far a line strays from the chords between its points, metres: the
 * gap at a quarter, half and three quarters of each piece to the point as
 * far along the chord. The rhumb line is its own chord on the chart.
 */
function chordGap(along: Line, a: LonLat, b: LonLat, points: LonLat[]): number {
  if (along === alongRhumb) {
    return 0;
  }
  const n = points.length - 1;
  let gap = 0;
  for (let i = 0; i < n; i++) {
    for (const s of [0.25, 0.5, 0.75]) {
      const chord = alongRhumb(points[i] as LonLat, points[i + 1] as LonLat, s);
      gap = Math.max(gap, haversine(along(a, b, (i + s) / n), chord));
    }
  }
  return gap;
}

/**
 * Corridor rings that together contain every point within `r` of both the
 * rhumb line a→b, as a chart plotter draws the leg, and its great circle,
 * as a course computer may steer it. Each line is split into pieces of
 * about max(SEGMENT_METRES, 4r) at equal fractions, so the last piece ends
 * on b, and each ring is widened by how far its line strays from the chord.
 */
export function legCorridors(a: LonLat, b: LonLat, r: number): LonLat[][] {
  const n = Math.max(1, Math.ceil(haversine(a, b) / Math.max(SEGMENT_METRES, 4 * r)));
  const gap = greatCircleOffset(a, b);
  const apart = gap > Math.max(GREAT_CIRCLE_TOLERANCE, r / 4);
  const lines = apart ? [alongRhumb, alongGreatCircle] : [alongRhumb];
  return lines.flatMap((along) => {
    const points = Array.from({ length: n + 1 }, (_, i) =>
      i === 0 ? a : i === n ? b : along(a, b, i / n)
    );
    const width = (apart ? r : r + gap) + chordGap(along, a, b, points);
    return points.slice(1).map((q, i) => corridorRing(points[i] as LonLat, q, width));
  });
}
