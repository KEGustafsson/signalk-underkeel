import type { Rect } from "../foundation/geo";
import { shiftRect, tileRange, tileRect, worldShifts } from "../foundation/geo";
import type { Geom, MeasuredGeom } from "../foundation/geometry";
import { measuredRectDistance, measureGeom, shiftGeom } from "../foundation/geometry";
import { normalCdf } from "../foundation/stats";
import { chartWeight, FLAG_SIGMAS, MAX_CHART_SIGMA } from "./chart-position";
import type { NodeStore } from "./node-store";
import { REACH_FLAGS } from "./walk";

/**
 * Survey shadow (plan §4.3). A tile g metres beyond a footprint and its
 * buffer lies under the footprint only if the chart is off by g there; and
 * the water charted closer to the footprint must then be off too, since what
 * its survey measured lies under the footprint unless it is. Within r metres
 * the closer water is placed by S(r), the widest survey σ of every tile less
 * than r from the buffer, the footprint's own included: it is off by r with
 * probability at most Φ(−r/S(r)). So a tile at g counts with at most
 *
 *   min over 0 < r ≤ g of Φ(−r/S(r)) = Φ(−ρ(g)),  ρ(g) = max over r ≤ g of r/S(r),
 *
 * beside its own Φ(−g/σ). A CATZOC D shoal 300 m off, behind 250 m of
 * CATZOC B water (σ 25 m), counts by Φ(−250/25) rather than by Φ(−300/500).
 *
 * Water whose position is not modelled stops the shadow: a tile with no
 * coverage, an unassessed or advisory survey or no depth, a block not loaded
 * or no node at all reads as σ = MAX_CHART_SIGMA, the widest modelled. S(r)
 * is the running maximum over every direction, not only the water between,
 * and ground distances are taken at the reach's poleward edge, never more
 * than the true distance, so ρ is never overstated.
 *
 * S(r) only rises with any tile's σ or flags and as any tile comes nearer,
 * and ρ(g) only rises with g, so a worse survey anywhere, a wider buffer or
 * a nearer tile never lowers a weight (invariant 2).
 */

/** The bound on a tile's weight at some distance, and the step of S(r) that set it. */
export interface Shadow {
  /** ρ(g): the weight is at most Φ(−ratio). 0 when nothing shadows. */
  ratio: number;
  /** Ground metres beyond the buffer of the water that shadows: the r that set ρ. */
  distance: number;
  /** σ of that water, S(r), metres. */
  sigmaP: number;
}

const UNSHADED: Shadow = Object.freeze({ ratio: 0, distance: 0, sigmaP: 0 });

/** S(r) rises to `sigma` for r beyond `at` ground metres. */
interface Step {
  at: number;
  sigma: number;
}

interface Entry {
  d: number;
  z: number;
  x: number;
  y: number;
}

/** The σ bound for a tile's subtree as the shadow reads it (MAX_CHART_SIGMA when not modelled). */
function levelOf(store: NodeStore, i: number, z: number, x: number, y: number): number {
  if (i < 0 || (store.isSplit(i) && store.standIn(i, z, x, y))) {
    return MAX_CHART_SIGMA;
  }
  const sigma = store.surveySigma(i);
  if (sigma <= 0 || (store.values(i).flags & REACH_FLAGS) !== 0) {
    return MAX_CHART_SIGMA;
  }
  return Math.min(sigma, MAX_CHART_SIGMA);
}

/**
 * The running maximum S(r) around one footprint, found nearest first: a
 * best-first search over the pyramid that descends only nodes whose widest σ
 * (or flags) could raise it, and stops once it reaches MAX_CHART_SIGMA or
 * the distance asked. A walk asks for growing distances; the search resumes
 * where it stopped.
 */
export class SurveyShadow {
  private readonly heap: Entry[] = [];
  private readonly steps: Step[] = [];
  private level = 0;
  /** Every tile nearer than this has been read. */
  private searched = 0;
  /** The last answer of `at`, for `lastG`. */
  private lastG = NaN;
  private last: Shadow = UNSHADED;
  private readonly measured: MeasuredGeom[];

  /**
   * @param geoms the footprint, and its copies one world over where its reach crosses ±180°
   * @param reach Mercator box holding every tile within the widest reach of the footprint
   * @param ground ground metres beyond the buffer of a Mercator distance from the footprint
   * @param limit Mercator distance beyond which no tile is read
   */
  constructor(
    private readonly store: NodeStore,
    geoms: readonly Geom[],
    reaches: readonly Rect[],
    private readonly ground: (mercator: number) => number,
    private readonly limit: number
  ) {
    this.measured = geoms.map(measureGeom);
    for (const reach of reaches) {
      const range = tileRange(store.minZoom, reach);
      for (let x = range.minX; x <= range.maxX; x++) {
        for (let y = range.minY; y <= range.maxY; y++) {
          this.offer(store.minZoom, x, y);
        }
      }
    }
  }

  /** Queues a tile within the limit, by its ground distance. */
  private offer(z: number, x: number, y: number): void {
    const rect = tileRect(z, x, y);
    let d = Infinity;
    for (const g of this.measured) {
      d = Math.min(d, measuredRectDistance(g, rect, this.limit));
    }
    if (d <= this.limit) {
      this.push({ d: this.ground(d), z, x, y });
    }
  }

  /** Reads tiles nearest first until every tile nearer than `g` is read. */
  private extend(g: number): void {
    while (this.heap.length > 0 && this.level < MAX_CHART_SIGMA) {
      const top = this.heap[0] as Entry;
      if (top.d >= g) {
        this.searched = Math.max(this.searched, g);
        return;
      }
      this.pop();
      const { d, z, x, y } = top;
      const i = this.store.find(z, x, y);
      const level = levelOf(this.store, i, z, x, y);
      if (level <= this.level) {
        continue;
      }
      if (i >= 0 && this.store.isSplit(i) && !this.store.standIn(i, z, x, y)) {
        this.offer(z + 1, 2 * x, 2 * y);
        this.offer(z + 1, 2 * x + 1, 2 * y);
        this.offer(z + 1, 2 * x, 2 * y + 1);
        this.offer(z + 1, 2 * x + 1, 2 * y + 1);
        continue;
      }
      this.steps.push({ at: d, sigma: level });
      this.level = level;
    }
    // Nothing left, or S(r) at the widest σ: no tile further out changes it.
    this.searched = Infinity;
  }

  /**
   * ρ(g) for a tile `g` ground metres beyond the buffer, and the water that set
   * it. The steps change only in a search, which runs before an answer and
   * never twice for one g, so a g asked again straight after reads the answer
   * kept, as a walk does for each tile. Callers must not change it.
   */
  at(g: number): Shadow {
    if (!(g > 0)) {
      return UNSHADED;
    }
    if (this.searched < g) {
      this.extend(g);
    }
    if (g === this.lastG) {
      return this.last;
    }
    let ratio = 0;
    let distance = 0;
    let sigmaP = 0;
    let sigma = MAX_CHART_SIGMA;
    for (let k = 0; k < this.steps.length; k++) {
      const step = this.steps[k] as Step;
      if (step.at >= g) {
        break;
      }
      sigma = step.sigma;
      const next = this.steps[k + 1];
      // S(r) = sigma on (step.at, end]: r/S(r) is largest at the end.
      const end = next !== undefined && next.at < g ? next.at : g;
      if (end / sigma > ratio) {
        ratio = end / sigma;
        distance = end;
        sigmaP = sigma;
      }
    }
    // No tile nearer than g at all: the water in between is not modelled.
    if (this.steps.length === 0 || (this.steps[0] as Step).at >= g) {
      if (g / sigma > ratio) {
        ratio = g / sigma;
        distance = g;
        sigmaP = sigma;
      }
    }
    this.lastG = g;
    this.last = { ratio, distance, sigmaP };
    return this.last;
  }

  private push(e: Entry): void {
    const a = this.heap;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as Entry).d <= e.d) {
        break;
      }
      a[i] = a[p] as Entry;
      i = p;
    }
    a[i] = e;
  }

  private pop(): void {
    const a = this.heap;
    const last = a.pop() as Entry;
    if (a.length === 0) {
      return;
    }
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      let md = last.d;
      if (l < a.length && (a[l] as Entry).d < md) {
        m = l;
        md = (a[l] as Entry).d;
      }
      if (r < a.length && (a[r] as Entry).d < md) {
        m = r;
      }
      if (m === i) {
        break;
      }
      a[i] = a[m] as Entry;
      i = m;
    }
    a[i] = last;
  }
}

/** A walk's survey shadow, searched on first use. */
export type ShadowOf = () => SurveyShadow;

/**
 * The shadow around a footprint out to Mercator distance `limit`, its widest
 * reach, within the box `reach`, with its copy one world over where that box
 * crosses ±180°; not searched until a walk asks (`SurveyShadow`).
 */
export function shadowFor(
  store: NodeStore,
  geom: Geom,
  reach: Rect,
  limit: number,
  ground: (mercator: number) => number
): ShadowOf {
  let shadow: SurveyShadow | undefined;
  return () =>
    (shadow ??= new SurveyShadow(
      store,
      worldShifts(reach).map((s) => (s === 0 ? geom : shiftGeom(geom, s))),
      worldShifts(reach).map((s) => shiftRect(reach, s)),
      ground,
      limit
    ));
}

/**
 * A tile's chart position weight `ground` metres beyond the buffer, placed
 * with σ, and the P it adds at P(UKC < 0) `p`, bounded by the shadow. A P
 * at most `floor` is returned unbounded without searching: the caller only
 * reads one above it.
 */
export function shadedWeight(
  shadow: ShadowOf | undefined,
  ground: number,
  sigma: number,
  p: number,
  floor: number
): { risk: number; weight: number; shadow?: { distance: number; sigmaP: number } } {
  const weight = chartWeight(ground, sigma);
  const risk = p * weight;
  // A tile at the buffer's edge counts in full: nothing lies between to shadow it.
  if (!shadow || ground <= 0 || risk <= floor) {
    return { risk, weight };
  }
  const s = shadow().at(ground);
  const cap = normalCdf(-s.ratio);
  if (cap >= weight) {
    return { risk, weight };
  }
  return { risk: p * cap, weight: cap, shadow: { distance: s.distance, sigmaP: s.sigmaP } };
}

/** The risk `shadedWeight` returns, without its explanation. */
export function shadedRisk(
  shadow: ShadowOf | undefined,
  ground: number,
  sigma: number,
  p: number,
  floor: number
): number {
  const weight = chartWeight(ground, sigma);
  const risk = p * weight;
  if (!shadow || ground <= 0 || risk <= floor) {
    return risk;
  }
  const cap = normalCdf(-shadow().at(ground).ratio);
  return cap >= weight ? risk : p * cap;
}

/**
 * Whether the water charted closer keeps a tile's flags from the footprint:
 * they count within FLAG_SIGMAS·σ of its survey (`flagReach`), and here
 * only where ρ(ground) is at most FLAG_SIGMAS too.
 */
export function flagsShadowed(shadow: ShadowOf | undefined, ground: number): boolean {
  return shadow !== undefined && shadow().at(ground).ratio > FLAG_SIGMAS;
}
