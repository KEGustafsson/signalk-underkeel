import type { LonLat } from "../foundation/geo";
import { project } from "../foundation/geo";

/**
 * Hull rectangle centred on `center`, its long axis along `heading`
 * (radians, true). Corners run bow-starboard, stern-starboard,
 * stern-port, bow-port.
 */
export function footprintRing(
  center: LonLat,
  heading: number,
  length: number,
  width: number
): LonLat[] {
  const bow = project(center, heading, length / 2);
  const stern = project(center, heading + Math.PI, length / 2);
  const starboard = heading + Math.PI / 2;
  const port = heading - Math.PI / 2;
  return [
    project(bow, starboard, width / 2),
    project(stern, starboard, width / 2),
    project(stern, port, width / 2),
    project(bow, port, width / 2)
  ];
}

const cross = (o: LonLat, a: LonLat, b: LonLat): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Convex hull of `points` (monotone chain), counter-clockwise in lon/lat.
 * Over a look-ahead's extent lon/lat is an affine image of the local plane
 * to within micrometres, so the hull contains every input footprint.
 */
export function convexHull(points: LonLat[]): LonLat[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) {
    return p;
  }
  const half = (list: LonLat[]): LonLat[] => {
    const out: LonLat[] = [];
    for (const q of list) {
      while (
        out.length >= 2 &&
        cross(out[out.length - 2] as LonLat, out[out.length - 1] as LonLat, q) <= 0
      ) {
        out.pop();
      }
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half([...p].reverse())];
}
