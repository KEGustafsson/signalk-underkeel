import { splitLine, splitRing } from "../foundation/antimeridian";
import type { LonLat } from "../foundation/geo";
import { wrapLon } from "../foundation/geo";
import { FLAGS } from "../spatial/node-store";
import type { FootprintResult, LookaheadResult, Thresholds, WorstPoint } from "./lookahead";

/**
 * Look-ahead envelope for `GET /envelope` (plan §4.10): the predicted
 * track, the swept cone split into segments of equal class (clear,
 * caution, danger, unverified), and the worst point with its explanation. Consecutive footprints of one class
 * are merged into one outline, vertices in line with their neighbours are
 * dropped, and coordinates are rounded to 1e-5° (about 1 m), so the payload
 * stays within the 15 kB budget (plan §6) however many footprints the
 * horizon holds.
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

/** Survey quality or source a depth cannot be called clear on. */
const UNVERIFIED_FLAGS = FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NOT_FOR_NAVIGATION;

/**
 * Colour class of a footprint (plan §5.4: green, amber, red by P). A
 * charted danger outranks missing coverage, since the danger is known
 * either way; otherwise any gap, an unassessed survey or an advisory
 * source makes the footprint unverified, and against a fallback water
 * level (`degraded`) nothing is clear.
 */
export function classOf(
  f: Pick<FootprintResult, "risk" | "uncovered" | "charted"> & { flags?: number },
  th: Thresholds,
  degraded = false
): FootprintClass {
  if (f.risk >= th.warn) {
    return "danger";
  }
  if (f.uncovered || f.charted === null || ((f.flags ?? 0) & UNVERIFIED_FLAGS) !== 0) {
    return "unverified";
  }
  if (f.risk >= th.alert) {
    return "caution";
  }
  return degraded ? "unverified" : "clear";
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

/**
 * Planar degrees (longitude scaled by cos(latitude)): a vertex this close
 * to the line through the vertices kept around it is dropped. 1e-7° is
 * about 1 cm, a hundredth of the 1e-5° the coordinates are rounded to, so
 * no drawn outline moves by a visible amount.
 */
const SIMPLIFY = 1e-7;

function offLine(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The ring without the vertices that lie within SIMPLIFY of the outline
 * of the others (Douglas–Peucker, both halves of the ring). Along a
 * straight track the sides of consecutive footprints line up, so a long
 * horizon's outline keeps its corners and turns, not one vertex per
 * footprint.
 */
function simplify(ring: LonLat[], xy: (p: LonLat) => XY): LonLat[] {
  const n = ring.length;
  if (n <= 4) {
    return ring;
  }
  const pts = ring.map(xy);
  const p0 = pts[0] as XY;
  let far = 0;
  pts.forEach((p, i) => {
    if (
      Math.hypot(p[0] - p0[0], p[1] - p0[1]) >
      Math.hypot((pts[far] as XY)[0] - p0[0], (pts[far] as XY)[1] - p0[1])
    ) {
      far = i;
    }
  });
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const at = (i: number) => pts[i % n] as XY;
  const stack: [number, number][] = [
    [0, far],
    [far, n]
  ];
  for (let span = stack.pop(); span; span = stack.pop()) {
    const [a, b] = span;
    let worst = -1;
    let max = SIMPLIFY;
    for (let i = a + 1; i < b; i++) {
      const d = offLine(at(i), at(a), at(b));
      if (d > max) {
        max = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return ring.filter((_, i) => keep[i] === 1);
}

function segmentFeature(
  run: FootprintResult[],
  all: FootprintResult[],
  start: number,
  th: Thresholds,
  degraded: boolean
): EnvelopeFeature {
  const first = run[0] as FootprintResult;
  const last = run[run.length - 1] as FootprintResult;
  const ring = simplify(outline(run, all, start), planar(first.center)).map(qp);
  ring.push(ring[0] as number[]);
  const means = run.map((f) => f.mean).filter((u): u is number => u !== null);
  const minMean = means.length > 0 ? Math.min(...means) : null;
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      kind: "segment",
      class: classOf(first, th, degraded),
      from: first.t,
      to: last.t,
      minUkc: minMean !== null && Number.isFinite(minMean) ? cm(minMean) : null,
      maxRisk: Math.round(Math.max(...run.map((f) => f.risk)) * 10000) / 10000
    }
  };
}

function runs(fps: FootprintResult[], th: Thresholds, degraded: boolean): FootprintResult[][] {
  const out: FootprintResult[][] = [];
  for (const f of fps) {
    const current = out[out.length - 1];
    const cls = (x: FootprintResult) => classOf(x, th, degraded);
    if (current && cls(current[0] as FootprintResult) === cls(f)) {
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

const lonLat = (c: number[]): LonLat => [c[0] as number, c[1] as number];

/**
 * The feature in [-180, 180]. Footprints near the antimeridian run past it,
 * so a line or ring crossing it is cut there into features that keep its
 * properties.
 */
function canonical(f: EnvelopeFeature): EnvelopeFeature[] {
  const g = f.geometry;
  if (g.type === "Point") {
    const [lon, lat] = lonLat(g.coordinates);
    return [{ ...f, geometry: { type: "Point", coordinates: qp([wrapLon(lon), lat]) } }];
  }
  if (g.type === "LineString") {
    return splitLine(g.coordinates.map(lonLat)).map((line) => ({
      ...f,
      geometry: { type: "LineString", coordinates: line.map(qp) }
    }));
  }
  const outer = (g.coordinates[0] ?? []).slice(0, -1).map(lonLat);
  return splitRing(outer).map((part) => {
    const ring = part.map(qp);
    ring.push(ring[0] as number[]);
    return { ...f, geometry: { type: "Polygon", coordinates: [ring] } };
  });
}

export function buildEnvelope(result: LookaheadResult, th: Thresholds): Envelope {
  const features: EnvelopeFeature[] = [];
  if (result.footprints.length > 1) {
    features.push(trackFeature(result));
  }
  const degraded = result.waterLevel?.degraded !== undefined;
  let start = 0;
  for (const run of runs(result.footprints, th, degraded)) {
    features.push(segmentFeature(run, result.footprints, start, th, degraded));
    start += run.length;
  }
  if (result.worst) {
    features.push(worstFeature(result.worst));
  }
  return { type: "FeatureCollection", features: features.flatMap(canonical) };
}

/** The highest rev any tracker in this process has issued. */
let issued = 0;

function firstRev(): number {
  issued = Math.max(Date.now(), issued + 1);
  return issued;
}

/** Metres a stationary envelope may wander before it is published again. */
export const ENVELOPE_DEADBAND = 5;

const M_PER_DEG = 111_320;

/** The geometry's vertex chains: a point is one chain of one vertex. */
function chains(g: EnvelopeFeature["geometry"]): number[][][] {
  return g.type === "Point"
    ? [[g.coordinates]]
    : g.type === "LineString"
      ? [g.coordinates]
      : g.coordinates;
}

/** Metres from p to the nearest edge or vertex of the chains, in a local plane at p. */
function distanceTo(p: number[], lines: number[][][]): number {
  const k = Math.cos(((p[1] as number) * Math.PI) / 180);
  const xy = (q: number[]): XY => [
    ((q[0] as number) - (p[0] as number)) * k,
    (q[1] as number) - (p[1] as number)
  ];
  let d = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const a = xy(line[i] as number[]);
      d = Math.min(d, offLine([0, 0], a, xy((line[i + 1] ?? line[i]) as number[])));
    }
  }
  return d * M_PER_DEG;
}

/** Every vertex of each geometry lies within `metres` of the other. */
function near(
  a: EnvelopeFeature["geometry"],
  b: EnvelopeFeature["geometry"],
  metres: number
): boolean {
  const ca = chains(a);
  const cb = chains(b);
  const inside = (from: number[][][], to: number[][][]) =>
    from.every((line) => line.every((p) => distanceTo(p, to) <= metres));
  return a.type === b.type && inside(ca, cb) && inside(cb, ca);
}

/** Probabilities, read as the whole percent the explanation prints. */
const PERCENT_KEYS = new Set(["maxRisk", "risk"]);

/**
 * The same reading: equal but for probabilities that round to the same
 * whole percent and a chart position (plan §4.3) whose distance moved at
 * most `metres`, which a graded chart position varies by as the vessel
 * jitters at rest; its weight follows from that distance.
 */
function sameReading(a: unknown, b: unknown, metres: number, key = ""): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (PERCENT_KEYS.has(key)) {
      return Math.round(a * 100) === Math.round(b * 100);
    }
    if (key === "weight") {
      return true;
    }
    return key === "distance" ? Math.abs(a - b) <= metres : a === b;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return a === b;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        sameReading((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], metres, k)
    )
  );
}

/** Same features with the same reading, each drawn within `metres` of the published one. */
function jitterOf(published: Envelope, next: Envelope, metres: number): boolean {
  return (
    published.features.length === next.features.length &&
    next.features.every((f, i) => {
      const p = published.features[i] as EnvelopeFeature;
      return (
        sameReading(p.properties, f.properties, metres) && near(p.geometry, f.geometry, metres)
      );
    })
  );
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

  /**
   * With a `deadband` (metres), used below low speed, GPS noise that moves
   * the drawing less than that and changes no class or number is not
   * published: each new rev costs every client a fetch.
   */
  update(next: Envelope, deadband = 0): boolean {
    const key = JSON.stringify(next);
    if (key === this.key || (deadband > 0 && jitterOf(this.envelope, next, deadband))) {
      return false;
    }
    this.key = key;
    this.envelope = next;
    this.rev++;
    issued = Math.max(issued, this.rev);
    return true;
  }
}
