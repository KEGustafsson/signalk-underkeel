import { fromMercator, tileRect } from "../foundation/geo";
import type { CellPosterior } from "./posterior";

/**
 * Suspected-shoal notes (plan §4.13): one Signal K note per discrepancy
 * cell, at `/resources/notes/underkeel-shoal-<quadkey>`, carrying the
 * evidence so the user can judge it on the chart.
 */

export function quadkey(z: number, x: number, y: number): string {
  let key = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    key += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return key;
}

export function noteId(c: CellPosterior): string {
  return `underkeel-shoal-${quadkey(c.z, c.x, c.y)}`;
}

export interface Discrepancy {
  id: string;
  position: { latitude: number; longitude: number };
  /** Posterior depth below chart datum and its σ, metres. */
  measured: number;
  sigma: number;
  /** Shallowest charted depth in the cell, metres. */
  charted: number;
  samples: number;
  passes: number;
  lastSeen: string;
}

export function discrepancyOf(c: CellPosterior): Discrepancy {
  const r = tileRect(c.z, c.x, c.y);
  const [longitude, latitude] = fromMercator((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    id: noteId(c),
    position: { latitude, longitude },
    measured: round(c.mean),
    sigma: round(c.sigma),
    charted: round(c.chartDepth),
    samples: c.samples,
    passes: c.passes,
    lastSeen: new Date(c.lastAt).toISOString()
  };
}

/**
 * The depth and σ a note shows: the depth floored to 5 cm and σ raised to the next cm, so a
 * note never shows the cell deeper or surer than the posterior.
 */
export function noteValues(c: CellPosterior): { measured: number; sigma: number } {
  let measured = Math.floor(c.mean * 20) / 20;
  let sigma = Math.ceil(c.sigma * 100) / 100;
  // The products can round across a step; one step more keeps the bound.
  if (measured > c.mean) {
    measured -= 0.05;
  }
  if (sigma < c.sigma) {
    sigma += 0.01;
  }
  return { measured, sigma };
}

/** The Signal K note for a discrepancy cell. */
export function noteOf(c: CellPosterior): Record<string, unknown> {
  return noteFor({ ...discrepancyOf(c), ...noteValues(c) });
}

/** The Signal K note body for a discrepancy. */
function noteFor(d: Discrepancy): Record<string, unknown> {
  return {
    name: `Suspected shoal ${d.measured} m (charted ${d.charted} m)`,
    description:
      `Own soundings put this cell at ${d.measured} m ± ${d.sigma} m below chart datum, ` +
      `shallower than the charted ${d.charted} m, from ${d.samples} samples on ${d.passes} passes. ` +
      `Last seen ${d.lastSeen}. Advisory: verify before relying on it.`,
    position: d.position,
    properties: { source: "signalk-underkeel", ...d }
  };
}
