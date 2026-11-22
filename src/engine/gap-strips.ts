import type { LonLat, Rect, XY } from "../foundation/geo";
import { emptyRect, expandRect, extendRect, toMercator, wrapLon } from "../foundation/geo";
import type { PolygonGeom } from "../foundation/geometry";
import { geomBounds, pointInPolygon, pointSegmentDistance } from "../foundation/geometry";
import { probabilityBelowZero } from "../foundation/stats";
import { FAIRWAY_GAP } from "../ingest/rule-features";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import type { DepthResult } from "../spatial/pyramid";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../spatial/pyramid";
import { SWEPT_SIGMA_D } from "../spatial/quality";
import { segmentsMeet } from "../spatial/rules";
import { REACH_FLAGS } from "../spatial/walk";
import { greatCircleOffset } from "./corridor";
import { queryWork } from "./work";

/**
 * Fairway gap strips under pilotage (plan §4.11, swept fairways). The FTIA keeps a fairway's
 * navigation line clear to its safe clearance depth through the gaps its swept areas leave under
 * a bridge, and publishes no fairway area there, so the strip along the line
 * (`ingest/fairway-gaps.ts`) is never built into the index's tiles: an ordinary check reads the
 * gap at its charted depth. A pilotage check, at the buffer the fix gives as it runs, holds the
 * stretches of a leg whose narrow corridor lies inside a strip to the strip's depth, the
 * guarantee's σ (SWEPT_SIGMA_D), and checks the rest of the corridor through the index, swept or
 * dredged all through (`route-check.ts`). The boat keeps to the line, its corridor off it by at
 * most the strip's half-width less the corridor's: a fix too poor for that closes the passage.
 */

/** Sampling step along a leg, ground metres. */
const STEP = 0.5;

interface Strip {
  depth: number;
  cellRef: number;
  polygons: readonly PolygonGeom[];
  bounds: Rect;
}

/** What a footprint inside a strip is held to: the strip's depth, and its cell. */
export interface StripHold {
  depth: number;
  cellRef: number;
}

/** A stretch of a leg, from and to fractions along its rhumb line, held to a strip. */
export interface StripSpan extends StripHold {
  from: number;
  to: number;
}

/**
 * The strips whose bounds meet `r`. One holding a charted hazard, a sounding, rock, wreck or
 * obstruction, shallower than its depth is left out: there the chart and the line's guarantee
 * disagree.
 */
function stripsNear(index: ChartIndex, r: Rect): Strip[] {
  if (index.rules.size === 0) {
    return [];
  }
  return index.rules.near(r).flatMap((f): Strip[] => {
    const depth = f.depth;
    if (f.objectClass !== FAIRWAY_GAP || depth === undefined || f.geom.type !== "polygon") {
      return [];
    }
    if (index.hazards.near(f.geom, 0).some((h) => h.feature.depth < depth)) {
      return [];
    }
    return [{ depth, cellRef: f.cellRef, polygons: f.geom.polygons, bounds: geomBounds(f.geom) }];
  });
}

/** Distance from `p` to the edge of `poly`, when `p` is inside it; else -1. */
function clearance(p: XY, poly: PolygonGeom): number {
  if (!pointInPolygon(p, poly)) {
    return -1;
  }
  let d = Infinity;
  for (const ring of [poly.outer, ...poly.holes]) {
    for (let i = 0; i < ring.length; i++) {
      d = Math.min(d, pointSegmentDistance(p, ring[i] as XY, ring[(i + 1) % ring.length] as XY));
    }
  }
  return d;
}

/** The fractions of segment a→b inside `r`, or undefined when it misses `r` (Liang–Barsky). */
function fractionsIn(a: XY, b: XY, r: Rect): [number, number] | undefined {
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [a[0] - b[0], a[0] - r.minX],
    [b[0] - a[0], r.maxX - a[0]],
    [a[1] - b[1], a[1] - r.minY],
    [b[1] - a[1], r.maxY - a[1]]
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) {
        return undefined;
      }
      continue;
    }
    const t = q / p;
    if (p < 0) {
      t0 = Math.max(t0, t);
    } else {
      t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1 ? [t0, t1] : undefined;
}

/**
 * The stretches of `[a, b]`, fractions along it, where every point within `reach` (Mercator) of
 * it lies inside one polygon of `strip`. Samples at most `step` apart each clear the edge by
 * `reach` and half their spacing: between two, every point is within half the spacing of one.
 */
function spansIn(a: XY, b: XY, strip: Strip, reach: number, step: number): StripSpan[] {
  const range = fractionsIn(a, b, strip.bounds);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (range === undefined || length === 0) {
    return [];
  }
  const n = Math.max(1, Math.ceil(((range[1] - range[0]) * length) / step));
  const spacing = ((range[1] - range[0]) * length) / n;
  const out: StripSpan[] = [];
  let open: number | undefined;
  let last = range[0];
  for (let k = 0; k <= n; k++) {
    const t = range[0] + ((range[1] - range[0]) * k) / n;
    const p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (strip.polygons.some((poly) => clearance(p, poly) >= reach + spacing / 2)) {
      open ??= t;
      last = t;
      continue;
    }
    if (open !== undefined && last > open) {
      out.push({ from: open, to: last, depth: strip.depth, cellRef: strip.cellRef });
    }
    open = undefined;
  }
  if (open !== undefined && last > open) {
    out.push({ from: open, to: last, depth: strip.depth, cellRef: strip.cellRef });
  }
  return out;
}

/** `spans` joined where they meet or overlap, each at the least depth of those joined. */
function joined(spans: StripSpan[]): StripSpan[] {
  const out: StripSpan[] = [];
  for (const s of [...spans].sort((x, y) => x.from - y.from)) {
    const prev = out[out.length - 1];
    if (prev && s.from <= prev.to) {
      prev.to = Math.max(prev.to, s.to);
      if (s.depth < prev.depth) {
        prev.depth = s.depth;
        prev.cellRef = s.cellRef;
      }
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * The stretches of the leg a→b, fractions along its rhumb line, whose corridor `r` metres each
 * side lies inside a fairway gap strip, ordered along the leg. The corridor is widened by how far
 * the leg's great circle strays from its rhumb line, as `legCorridors` widens it.
 */
export function stripSpans(index: ChartIndex, a: LonLat, b: LonLat, r: number): StripSpan[] {
  if (index.rules.size === 0) {
    return [];
  }
  const from = toMercator(a[0], a[1]);
  const to = toMercator(a[0] + wrapLon(b[0] - a[0]), b[1]);
  const box = emptyRect();
  extendRect(box, from[0], from[1]);
  extendRect(box, to[0], to[1]);
  const wide = r + greatCircleOffset(a, b);
  const strips = stripsNear(index, expandRect(box, mercatorBuffer(box, wide)));
  return joined(
    strips.flatMap((s) =>
      spansIn(from, to, s, mercatorBuffer(s.bounds, wide), mercatorBuffer(s.bounds, STEP))
    )
  );
}

/** The strip holding the whole of `ring`, a box's footprint, when one does. */
export function stripHolding(index: ChartIndex, ring: readonly LonLat[]): StripHold | undefined {
  const merc = ring.map((p) => toMercator(p[0], p[1]));
  const box = emptyRect();
  merc.forEach((p) => {
    extendRect(box, p[0], p[1]);
  });
  const inside = (poly: PolygonGeom): boolean =>
    merc.every((p) => pointInPolygon(p, poly)) &&
    !merc.some((p, i) =>
      [poly.outer, ...poly.holes].some((edge) =>
        edge.some((q, k) =>
          segmentsMeet(p, merc[(i + 1) % merc.length] as XY, q, edge[(k + 1) % edge.length] as XY)
        )
      )
    );
  const held = stripsNear(index, box).filter((s) => s.polygons.some(inside));
  const least = held.sort((x, y) => x.depth - y.depth)[0];
  return least && { depth: least.depth, cellRef: least.cellRef };
}

/**
 * The footprint `ring`, inside a strip, read at the strip's depth: SWEPT, with the coverage and
 * survey flags, σP and cells the index gives over it. `unswept` when the index has land, no
 * coverage or water the chart has drying over it, where the chart and the line's guarantee
 * disagree, or the boat's own soundings made it shallower (invariant 5): the strip then holds
 * nothing.
 */
export function heldDepth(
  index: ChartIndex,
  ring: LonLat[],
  hold: StripHold,
  risk: { threshold: number; sigmaExtra: number }
): { result: DepthResult; work: number } {
  const q = minDepthOver(index.pyramid, footprintGeom(ring), {});
  if (q.dMin < 0 || (q.flags & FLAGS.LIVECHART_ADJUSTED) !== 0) {
    return { result: { ...q, maxRisk: 0, unswept: true }, work: queryWork(q) };
  }
  const v = {
    dMin: hold.depth,
    sigmaD: SWEPT_SIGMA_D,
    sigmaP: q.sigmaP,
    flags: (q.flags & REACH_FLAGS) | FLAGS.SWEPT,
    cellRef: hold.cellRef
  };
  const p = probabilityBelowZero(
    hold.depth - risk.threshold,
    Math.hypot(SWEPT_SIGMA_D, risk.sigmaExtra)
  );
  const center: LonLat = [
    ring.reduce((s, x) => s + x[0], 0) / ring.length,
    ring.reduce((s, x) => s + x[1], 0) / ring.length
  ];
  return {
    result: {
      ...v,
      coveredDMin: hold.depth,
      cellRefs: [...new Set([...q.cellRefs, hold.cellRef])],
      visits: q.visits,
      maxRisk: p,
      riskTile: { ...v, risk: p, center },
      unswept: false
    },
    work: queryWork(q)
  };
}
