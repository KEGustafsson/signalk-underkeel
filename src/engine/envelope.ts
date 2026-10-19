import type { LonLat } from "../foundation/geo";
import type { FootprintResult, LookaheadResult, Thresholds, WorstPoint } from "./lookahead";

/**
 * Look-ahead envelope for `GET /envelope` (plan §4.10): the predicted
 * track, the swept cone split into segments of equal class (clear,
 * caution, danger, unverified), and the worst point with its explanation. Consecutive footprints of one class
 * are merged into one outline, and coordinates are rounded to 1e-5°
 * (about 1 m), so the payload stays within the 15 kB budget (plan §6)
 * however many footprints the horizon holds.
 */

export interface EnvelopeFeature {
  type: "Feature";
  geometry:
    | { type: "LineString"; coordinates: number[][] }
    | { type: "Polygon"; coordinates: number[][][] }
    | { type: "Point"; coordinates: number[] };
  properties: Record<string, unknown>;
}

export interface Envelope {
  type: "FeatureCollection";
  features: EnvelopeFeature[];
}

const q = (v: number): number => Math.round(v * 1e5) / 1e5;
const qp = (p: LonLat): number[] => [q(p[0]), q(p[1])];
const cm = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

export type FootprintClass = "clear" | "caution" | "danger" | "unverified";

/**
 * Colour class of a footprint (plan §5.4: green, amber, red by P). A
 * charted danger outranks missing coverage, since the danger is known
 * either way; otherwise any gap makes the footprint unverified.
 */
export function classOf(
  f: Pick<FootprintResult, "risk" | "uncovered" | "charted">,
  th: Thresholds
): FootprintClass {
  if (f.risk >= th.warn) {
    return "danger";
  }
  if (f.uncovered || f.charted === null) {
    return "unverified";
  }
  return f.risk >= th.alert ? "caution" : "clear";
}

/** At most this many vertices on the drawn track line. */
const MAX_TRACK_POINTS = 60;

function trackFeature(result: LookaheadResult): EnvelopeFeature {
  const fps = result.footprints;
  const every = Math.ceil(fps.length / MAX_TRACK_POINTS);
  const points = fps.filter((_, i) => i % every === 0 || i === fps.length - 1);
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: points.map((f) => qp(f.center)) },
    properties: { kind: "track", horizon: result.horizon }
  };
}

type XY = [number, number];

/** Local plane around `origin` with longitude scaled by cos(latitude), so directions keep their angles. */
function planar(origin: LonLat): (p: LonLat) => XY {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return (p) => [(p[0] - origin[0]) * k, p[1] - origin[1]];
}

/** The ring counter-clockwise; footprint rectangles run clockwise, hulls counter-clockwise. */
function ccw(ring: LonLat[], xy: (p: LonLat) => XY): LonLat[] {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = xy(ring[i] as LonLat);
    const [bx, by] = xy(ring[(i + 1) % ring.length] as LonLat);
    area += ax * by - bx * ay;
  }
  return area < 0 ? [...ring].reverse() : ring;
}

/** Index of the vertex furthest along `dir`. */
function extreme(ring: LonLat[], dir: XY, xy: (p: LonLat) => XY): number {
  let best = 0;
  let max = -Infinity;
  ring.forEach((p, i) => {
    const [x, y] = xy(p);
    const d = x * dir[0] + y * dir[1];
    if (d > max) {
      max = d;
      best = i;
    }
  });
  return best;
}

/** Vertices from index `from` to `to`, counter-clockwise, both included. */
function arc(ring: LonLat[], from: number, to: number): LonLat[] {
  const out: LonLat[] = [];
  for (let i = from; ; i = (i + 1) % ring.length) {
    out.push(ring[i] as LonLat);
    if (i === to) {
      return out;
    }
  }
}

/**
 * Outline of a run of footprints. Each footprint is a convex polygon (one
 * hull rectangle, or the hull of the fan's five), so its sides are found by
 * direction, not by vertex position: the port and starboard extremes across
 * the local track, the stern of the first footprint and the bow of the last.
 */
function outline(run: FootprintResult[], all: FootprintResult[], start: number): LonLat[] {
  const first = run[0] as FootprintResult;
  const xy = planar(first.center);
  if (run.length === 1) {
    return ccw(first.ring, xy);
  }
  const sides = run.map((f, k) => {
    const i = start + k;
    const a = xy((all[Math.max(0, i - 1)] as FootprintResult).center);
    const b = xy((all[Math.min(all.length - 1, i + 1)] as FootprintResult).center);
    const n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dir: XY = [(b[0] - a[0]) / n, (b[1] - a[1]) / n];
    const ring = ccw(f.ring, xy);
    return {
      ring,
      starboard: extreme(ring, [dir[1], -dir[0]], xy),
      port: extreme(ring, [-dir[1], dir[0]], xy)
    };
  });
  const head = sides[0] as (typeof sides)[number];
  const tail = sides[sides.length - 1] as (typeof sides)[number];
  const middle = sides.slice(1, -1);
  return [
    // Counter-clockwise: round the stern, up the starboard side, round the bow, down the port side.
    ...arc(head.ring, head.port, head.starboard),
    ...middle.map((s) => s.ring[s.starboard] as LonLat),
    ...arc(tail.ring, tail.starboard, tail.port),
    ...[...middle].reverse().map((s) => s.ring[s.port] as LonLat)
  ];
}

function segmentFeature(
  run: FootprintResult[],
  all: FootprintResult[],
  start: number,
  th: Thresholds
): EnvelopeFeature {
  const first = run[0] as FootprintResult;
  const last = run[run.length - 1] as FootprintResult;
  const ring = outline(run, all, start).map(qp);
  ring.push(ring[0] as number[]);
  const means = run.map((f) => f.mean).filter((u): u is number => u !== null);
  const minMean = means.length > 0 ? Math.min(...means) : null;
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      kind: "segment",
      class: classOf(first, th),
      from: first.t,
      to: last.t,
      minUkc: minMean !== null && Number.isFinite(minMean) ? cm(minMean) : null,
      maxRisk: Math.round(Math.max(...run.map((f) => f.risk)) * 10000) / 10000
    }
  };
}

function runs(fps: FootprintResult[], th: Thresholds): FootprintResult[][] {
  const out: FootprintResult[][] = [];
  for (const f of fps) {
    const current = out[out.length - 1];
    if (current && classOf(current[0] as FootprintResult, th) === classOf(f, th)) {
      current.push(f);
    } else {
      out.push([f]);
    }
  }
  return out;
}

function worstFeature(w: WorstPoint): EnvelopeFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: qp(w.position) },
    properties: { kind: "worst", t: w.t, explanation: w.explanation }
  };
}

export function buildEnvelope(result: LookaheadResult, th: Thresholds): Envelope {
  const features: EnvelopeFeature[] = [];
  if (result.footprints.length > 1) {
    features.push(trackFeature(result));
  }
  let start = 0;
  for (const run of runs(result.footprints, th)) {
    features.push(segmentFeature(run, result.footprints, start, th));
    start += run.length;
  }
  if (result.worst) {
    features.push(worstFeature(result.worst));
  }
  return { type: "FeatureCollection", features };
}

/** The highest rev any tracker in this process has issued. */
let issued = 0;

function firstRev(): number {
  issued = Math.max(Date.now(), issued + 1);
  return issued;
}

/**
 * Holds the latest envelope and bumps `rev` only when its content changes. `rev` starts at the
 * wall-clock ms of creation (and above any rev issued before in this process), so a client
 * holding a rev from before a restart never gets 304 for content it has not seen. It stays an
 * integer well below 2^53.
 */
export class EnvelopeTracker {
  rev = firstRev();
  envelope: Envelope = { type: "FeatureCollection", features: [] };
  private key = JSON.stringify(this.envelope);

  update(next: Envelope): boolean {
    const key = JSON.stringify(next);
    if (key === this.key) {
      return false;
    }
    this.key = key;
    this.envelope = next;
    this.rev++;
    issued = Math.max(issued, this.rev);
    return true;
  }
}
