import { RING_REACH } from "./engine/route-check";
import type { LonLat } from "./foundation/geo";
import { EARTH_RADIUS, haversine } from "./foundation/geo";

/** The planning API's boxes on the ground (`planning-api.ts`). */

/**
 * How far the corridor of a leg with both ends in the box sw–ne may stray past it, beyond `r`:
 * the leg's great circle bows toward the pole by at most diag² · tan|φ| / 8R (φ the box's
 * poleward latitude), and its corridor is widened by that gap or drawn along it
 * (`legCorridors`). Doubled, and a metre more, for the chord gap between its points.
 */
export function greatCircleBulge(sw: LonLat, ne: LonLat): number {
  const diag = haversine(sw, ne);
  const lat = (Math.max(Math.abs(sw[1]), Math.abs(ne[1])) * Math.PI) / 180;
  return (2 * diag * diag * Math.tan(lat)) / (8 * EARTH_RADIUS) + 1;
}

/**
 * sw–ne grown on every side by the reach of a corridor ring past its leg's end (`RING_REACH`
 * half-widths: a diagonal leg's ring corner lies r√2 from its end) and by the great-circle
 * bulge of any leg inside it: it contains the r-buffer of the box and every corridor ring of
 * every leg whose ends lie in the box, so a leg inside a box is never riskier than the box.
 */
export function grownBox(sw: LonLat, ne: LonLat, r: number): LonLat[] {
  const k = Math.PI / 180;
  const grow = r * RING_REACH + greatCircleBulge(sw, ne);
  const dLat = grow / (EARTH_RADIUS * k);
  const s = sw[1] - dLat;
  const n = ne[1] + dLat;
  const cos = Math.cos(Math.max(Math.abs(s), Math.abs(n)) * k);
  const dLon = grow / (EARTH_RADIUS * k * Math.max(cos, 1e-6));
  const w = sw[0] - dLon;
  const e = ne[0] + dLon;
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n]
  ];
}

export function areaKm2(ring: LonLat[]): number {
  const k = Math.PI / 180;
  const [w, s] = ring[0] as LonLat;
  const [e, n] = ring[2] as LonLat;
  const width = (e - w) * k * EARTH_RADIUS * Math.cos(((s + n) / 2) * k);
  return (width * (n - s) * k * EARTH_RADIUS) / 1e6;
}
