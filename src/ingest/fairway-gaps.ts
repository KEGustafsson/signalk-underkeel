import type { WfsFeature } from "./wfs-fetch";
import { num } from "./wfs-fetch";

/**
 * Gaps in a swept fairway (plan §4.11, swept fairways). The FTIA leaves a fairway's swept areas
 * off where a bridge spans it: at Lillholmen, Pargas, its boat route 3530 is swept to 2.7 m on
 * both sides of the bridge, about 36 m wide, and nothing is published for the 70 m under it,
 * where the Traficom WFS charts the 0–3 m band of the banks. The fairway's navigation line runs
 * on through the gap with its own safe clearance depth (`haraussyvyys`), the depth the fairway
 * authority keeps the line clear to and answers for. The guarantee is the line's: no FTIA or
 * Traficom layer publishes the fairway's extent inside the gap, so no width around the line is
 * guaranteed there. Where one line leaves a swept area and enters another within GAP_MAX metres,
 * the gap is given a strip along the line, as wide each side as the narrower of the two areas
 * where the line leaves and enters them and at most HALF_MAX metres (a bridge's opening may be
 * narrower than the fairway), at the line's safe clearance depth or the least swept depth of the
 * areas it reaches into, whichever is less: never more than was swept on either side. A line
 * without a safe clearance depth gives its design draft (`mitoitussyvays`) instead, the static
 * draft of the vessel it is laid out for, which is less than the depth by the gross under-keel
 * clearance (0.2–0.6 m on a boat route, Traficom's depth instructions). The cell keeps the strips
 * apart from its depths, as `FAIRWAYGAP` (`wfs.ts`), which the index never builds into its
 * tiles: an ordinary check reads the gap at its charted depth, and only a pilotage check holds a
 * leg to a strip, where the leg's narrow corridor lies inside it (`engine/gap-strips.ts`). The
 * FTIA states each line's and area's reference level (`vertaustaso`, the mean water of an epoch
 * such as MW2005 or MW2020, or N2000), and the cell keeps their depths as given, stating no datum
 * (`wfs.ts`): a strip is made only where the line and every area it reaches into state the same
 * one.
 */

/** The longest gap along a line that is bridged, metres. */
export const GAP_MAX = 150;
/** The widest a strip reaches either side of its line, metres. */
export const HALF_MAX = 10;
/** Sampling step along a line, metres. */
const STEP = 2;
/**
 * Samples a strip reaches back into each area it joins, while the line is in swept water. A
 * pilotage check holds a leg to a strip from where the leg's narrow corridor lies inside it, at
 * least that corridor's half-width past the strip's end, and checks the corridor before that
 * point through the index, which reaches another half-width on (`engine/gap-strips.ts`): with
 * half-widths up to HALF_MAX, twice that, a tile of the edge zoom (about 5 m at 60° N) across the
 * area's end, and room for the sampling.
 */
const OVERLAP = Math.ceil(30 / STEP);
/** How far a cross-section looks for an area's edge, metres. */
const REACH = 100;

type XY = [number, number];

interface Area {
  id: string;
  depth: number;
  reference: string | undefined;
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

/** A feature's reference level (`vertaustaso`), which the FTIA spells in either case at times. */
export function referenceOf(f: WfsFeature): string | undefined {
  const v = f.properties?.vertaustaso;
  return typeof v === "string" && v.trim() !== "" ? v.trim().toUpperCase() : undefined;
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
 * Distance from `p` along unit `v` to the first edge of `rings`, or Infinity within REACH. A `p`
 * on an edge is 0 from it: a line along an area's edge has no width of it on that side.
 */
function toEdge(p: XY, v: XY, rings: XY[][]): number {
  let best = Infinity;
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
  const rings = a.polygons.flat();
  return [
    Math.min(HALF_MAX, toEdge(s.p, left, rings)),
    Math.min(HALF_MAX, toEdge(s.p, right, rings))
  ];
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

/**
 * How far the strip along `run` may reach left and right before a hole of an area it reaches
 * into, or undefined when its gap lies in one. A hole is water left out of the sweep, and
 * `widest` takes the strip's width further into the area than a hole beside the line, so each
 * hole is checked along the whole strip: across the line at each sample, and at each of its
 * corners within half a STEP along the line of one, which the cross-sections can pass between.
 */
function clearOfHoles(run: Sample[], areas: Area[]): [number, number] | undefined {
  const reach: [number, number] = [Infinity, Infinity];
  const held = [...new Set(run.flatMap((s) => s.areas))];
  for (const hole of held.flatMap((k) => (areas[k] as Area).polygons.flatMap((r) => r.slice(1)))) {
    for (const s of run) {
      if (s.areas.length === 0 && inRing(s.p, hole)) {
        return undefined;
      }
      reach[0] = Math.min(reach[0], toEdge(s.p, [-s.t[1], s.t[0]], [hole]));
      reach[1] = Math.min(reach[1], toEdge(s.p, [s.t[1], -s.t[0]], [hole]));
      for (const q of hole) {
        const dx = q[0] - s.p[0];
        const dy = q[1] - s.p[1];
        if (Math.abs(dx * s.t[0] + dy * s.t[1]) <= STEP / 2) {
          const left = s.t[0] * dy - s.t[1] * dx;
          const side = left > 0 ? 0 : 1;
          reach[side] = Math.min(reach[side], Math.abs(left));
        }
      }
    }
  }
  return reach;
}

/** The strip along `run`, each sample's `half` metres left and right of it. */
function strip(run: Sample[], half: [number, number][]): XY[] {
  const at = (k: number): [number, number] => half[k] ?? [0, 0];
  const left = run.map((s, k) => [s.p[0] - s.t[1] * at(k)[0], s.p[1] + s.t[0] * at(k)[0]] as XY);
  const right = run.map((s, k) => [s.p[0] + s.t[1] * at(k)[1], s.p[1] - s.t[0] * at(k)[1]] as XY);
  const ring = [...left, ...right.reverse()];
  return [...ring, ring[0] as XY];
}

/**
 * The strips bridging the gaps of the swept areas `swept` (dredged areas, DRVAL1 their swept
 * depth) along the navigation lines `lines` (with `haraussyvyys`, else `mitoitussyvays`), each
 * with DRVAL1 the depth it holds under pilotage. Each line and area carries its `vertaustaso`.
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
    reference: referenceOf(f),
    polygons: polygonsOf(f.geometry).map((rings) => rings.map((r) => r.map((p) => plane.to(p))))
  }));
  const out: WfsFeature[] = [];
  for (const line of lines) {
    // The safe clearance depth the line is kept to, else the draft it is laid out for.
    const kept = num(line.properties?.haraussyvyys) ?? num(line.properties?.mitoitussyvays);
    const reference = referenceOf(line);
    if (kept === undefined || kept <= 0 || reference === undefined) {
      continue;
    }
    for (const part of linePartsOf(line.geometry)) {
      const samples = samplesOf(
        part.map((p) => plane.to(p)),
        areas
      );
      out.push(...gapsAlong(samples, areas, { kept, reference }, plane.from));
    }
  }
  return out;
}

/**
 * The areas a gap from `before` to `after` lies between, or undefined when it crosses a hole or a
 * part one area leaves out.
 */
function between(before: Sample, after: Sample | undefined): [number, number] | undefined {
  const [ka, kb] = [before.areas[0], after?.areas[0]];
  if (after === undefined || ka === undefined || kb === undefined) {
    return undefined;
  }
  return after.areas.some((k) => before.areas.includes(k)) ? undefined : [ka, kb];
}

/**
 * The samples from `i - 1`, the last before a gap, to `j`, the first after it, and on up to
 * OVERLAP samples each way while the line is in swept water: a strip never reaches past the areas
 * it joins into water no sweep covers.
 */
function runAround(samples: Sample[], i: number, j: number): Sample[] {
  const swept = (k: number): boolean => (samples[k]?.areas.length ?? 0) > 0;
  let lo = i - 1;
  while (lo > 0 && i - 1 - lo < OVERLAP && swept(lo - 1)) {
    lo--;
  }
  let hi = j;
  while (hi < samples.length - 1 && hi - j < OVERLAP && swept(hi + 1)) {
    hi++;
  }
  return samples.slice(lo, hi + 1);
}

/**
 * The half-widths of the strip at each sample of `run`: `half`, and past BACK metres from the gap
 * no wider than the areas holding the sample, so a strip reaching further into an area than the
 * cross-sections its width is taken from stays inside it.
 */
function halvesAlong(
  run: Sample[],
  half: [number, number],
  ends: { before: Sample; after: Sample },
  areas: Area[]
): [number, number][] {
  return run.map((s) => {
    const far = s.along < ends.before.along - BACK || s.along > ends.after.along + BACK;
    if (!far || s.areas.length === 0) {
      return half;
    }
    const own = s.areas.map((k) => halves(s, areas[k] as Area));
    return [
      Math.min(half[0], Math.max(...own.map((h) => h[0]))),
      Math.min(half[1], Math.max(...own.map((h) => h[1])))
    ];
  });
}

/**
 * The gaps along one line's samples: runs outside every area between two areas. A run that
 * leaves an area and comes back into it crosses a hole or a part the FTIA left out of it, also
 * where another area overlaps it at either end.
 */
function gapsAlong(
  samples: Sample[],
  areas: Area[],
  line: { kept: number; reference: string },
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
    const ends = between(before, after);
    if (after && ends && after.along - before.along <= GAP_MAX) {
      const strip = stripOver(samples, { i, j, ends: [before, after] }, areas, line);
      if (strip) {
        out.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [strip.ring.map(from)] },
          properties: strip.properties
        });
      }
    }
    i = j;
  }
  return out;
}

/**
 * The strip over the gap from sample `i - 1` to sample `j` between areas `ends`, its ring in the
 * local plane, or undefined when an area it reaches into states another reference level, or it
 * has no width on a side.
 */
function stripOver(
  samples: Sample[],
  gap: { i: number; j: number; ends: [Sample, Sample] },
  areas: Area[],
  line: { kept: number; reference: string }
): { ring: XY[]; properties: Record<string, unknown> } | undefined {
  const [before, after] = gap.ends;
  const [ka, kb] = [before.areas[0] as number, after.areas[0] as number];
  const run = runAround(samples, gap.i, gap.j);
  const held = [...new Set(run.flatMap((s) => s.areas))];
  if (!held.every((k) => areas[k]?.reference === line.reference)) {
    return undefined;
  }
  const [al, ar] = widest(samples, before, ka, areas);
  const [bl, br] = widest(samples, after, kb, areas);
  const holes = clearOfHoles(run, areas) ?? [0, 0];
  const half: [number, number] = [Math.min(al, bl, holes[0]), Math.min(ar, br, holes[1])];
  if (!(half[0] > 0 && half[1] > 0 && Number.isFinite(half[0] + half[1]))) {
    return undefined;
  }
  return {
    ring: strip(run, halvesAlong(run, half, { before, after }, areas)),
    properties: {
      DRVAL1: Math.min(line.kept, ...run.map((s) => s.depth)),
      IDENTIFIER: `FTIA-GAP-${(areas[ka] as Area).id}-${(areas[kb] as Area).id}`
    }
  };
}
