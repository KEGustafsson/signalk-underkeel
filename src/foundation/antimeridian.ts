import type { LonLat } from "./geo";

/**
 * Cutting at the antimeridian (RFC 7946 §3.1.9). The engine builds lines and
 * rings continuous across ±180° so the spatial query sees one shape; data it
 * hands out is cut at each 180° meridian it crosses, and every part is
 * moved by whole turns into [-180, 180].
 */

/** World copy of a longitude: 0 for [-180, 180), 1 for [180, 540), and so on. */
function worldOf(lon: number): number {
  return Math.floor((lon + 180) / 360);
}

function shifted(points: readonly LonLat[], world: number): LonLat[] {
  return points.map((p) => [p[0] - 360 * world, p[1]]);
}

function pushDistinct(out: LonLat[], p: LonLat): void {
  const last = out[out.length - 1];
  if (!last || last[0] !== p[0] || last[1] !== p[1]) {
    out.push(p);
  }
}

/** The line cut where it crosses a 180° meridian, each part in [-180, 180]. */
export function splitLine(line: readonly LonLat[]): LonLat[][] {
  const parts: LonLat[][] = [];
  let current: LonLat[] = [];
  line.forEach((p, i) => {
    const a = line[i - 1];
    if (a) {
      const [w0, w1] = [worldOf(a[0]), worldOf(p[0])];
      const step = Math.sign(w1 - w0);
      for (let w = w0; w !== w1; w += step) {
        const x = -180 + 360 * (step > 0 ? w + 1 : w);
        const q: LonLat = [x, a[1] + ((x - a[0]) / (p[0] - a[0])) * (p[1] - a[1])];
        pushDistinct(current, q);
        parts.push(current);
        current = [q];
      }
    }
    pushDistinct(current, p);
  });
  parts.push(current);
  return parts
    .filter((part) => part.length >= 2)
    .map((part) => {
      const [a, b] = part as [LonLat, LonLat];
      return shifted(part, worldOf((a[0] + b[0]) / 2));
    });
}

/** Sutherland–Hodgman against the half-plane `inside`, with crossings on x = `edge`. */
function clipAt(ring: readonly LonLat[], edge: number, inside: (x: number) => boolean): LonLat[] {
  const out: LonLat[] = [];
  ring.forEach((p, i) => {
    const a = ring[(i + ring.length - 1) % ring.length] as LonLat;
    if (inside(p[0]) !== inside(a[0])) {
      pushDistinct(out, [edge, a[1] + ((edge - a[0]) / (p[0] - a[0])) * (p[1] - a[1])]);
    }
    if (inside(p[0])) {
      pushDistinct(out, p);
    }
  });
  return out;
}

function area(ring: readonly LonLat[]): number {
  let twice = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length] as LonLat;
    twice += p[0] * q[1] - q[0] * p[1];
  });
  return twice / 2;
}

/**
 * The parts of an open ring in each world copy it spans, each moved into
 * [-180, 180]; a ring wholly in one copy comes back whole.
 */
export function splitRing(ring: readonly LonLat[]): LonLat[][] {
  const worlds = ring.map((p) => worldOf(p[0]));
  const lo = Math.min(...worlds);
  const hi = Math.max(...worlds);
  const parts: LonLat[][] = [];
  for (let w = lo; w <= hi; w++) {
    const west = -180 + 360 * w;
    const east = west + 360;
    const part = clipAt(
      clipAt(ring, west, (x) => x >= west),
      east,
      (x) => x <= east
    );
    // A ring that only touches this copy's edge leaves a part with no area.
    if (part.length >= 3 && area(part) !== 0) {
      parts.push(shifted(part, w));
    }
  }
  return parts;
}
