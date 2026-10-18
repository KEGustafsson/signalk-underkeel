import type { LonLat } from "../foundation/geo";
import type { FootprintResult, LookaheadResult, WorstPoint } from "./lookahead";

/**
 * Look-ahead envelope for `GET /envelope` (plan §4.10): the predicted
 * track, the swept cone split into segments of equal class (clear, shoal,
 * unverified), and the worst point. Consecutive footprints of one class
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

export type FootprintClass = "clear" | "shoal" | "unverified";

/** A charted shoal outranks missing coverage: the danger is known either way. */
export function classOf(f: Pick<FootprintResult, "ukc" | "uncovered">): FootprintClass {
  if (f.ukc !== null && f.ukc < 0) {
    return "shoal";
  }
  return f.uncovered || f.ukc === null ? "unverified" : "clear";
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

/**
 * Outline of a run of footprints: starboard corners stern to bow, then
 * port corners bow to stern. Rings are [bow-stbd, stern-stbd, stern-port,
 * bow-port] (see footprintRing).
 */
function segmentFeature(run: FootprintResult[]): EnvelopeFeature {
  const first = run[0] as FootprintResult;
  const last = run[run.length - 1] as FootprintResult;
  const starboard = [first.ring[1] as LonLat, ...run.map((f) => f.ring[0] as LonLat)];
  const port = [...run].reverse().map((f) => f.ring[3] as LonLat);
  port.push(first.ring[2] as LonLat);
  const ring = [...starboard, ...port].map(qp);
  ring.push(ring[0] as number[]);
  const ukcs = run.map((f) => f.ukc).filter((u): u is number => u !== null);
  const minUkc = ukcs.length > 0 ? Math.min(...ukcs) : null;
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      kind: "segment",
      class: classOf(first),
      from: first.t,
      to: last.t,
      minUkc: minUkc !== null && Number.isFinite(minUkc) ? cm(minUkc) : null
    }
  };
}

function runs(fps: FootprintResult[]): FootprintResult[][] {
  const out: FootprintResult[][] = [];
  for (const f of fps) {
    const current = out[out.length - 1];
    if (current && classOf(current[0] as FootprintResult) === classOf(f)) {
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
    properties: {
      kind: "worst",
      t: w.t,
      charted: Number.isFinite(w.charted) ? cm(w.charted) : null,
      ukc: Number.isFinite(w.ukc) ? cm(w.ukc) : null,
      cell: w.cell,
      hazard: w.hazard && {
        ...w.hazard,
        depth: Number.isFinite(w.hazard.depth) ? cm(w.hazard.depth) : null
      }
    }
  };
}

export function buildEnvelope(result: LookaheadResult): Envelope {
  const features: EnvelopeFeature[] = [];
  if (result.footprints.length > 1) {
    features.push(trackFeature(result));
  }
  features.push(...runs(result.footprints).map(segmentFeature));
  if (result.worst) {
    features.push(worstFeature(result.worst));
  }
  return { type: "FeatureCollection", features };
}

/** Holds the latest envelope and bumps `rev` only when its content changes. */
export class EnvelopeTracker {
  rev = 0;
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
    return true;
  }
}
