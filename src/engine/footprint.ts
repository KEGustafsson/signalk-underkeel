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
