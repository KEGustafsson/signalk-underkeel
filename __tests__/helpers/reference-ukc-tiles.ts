import { rectGap, tileRect, tileSize } from "../../src/foundation/geo";
import { probabilityBelowZero } from "../../src/foundation/stats";
import type { UkcClass, UkcRect, UkcTileInput } from "../../src/engine/ukc-tiles";
import { DETAIL_ZOOMS } from "../../src/engine/ukc-tiles";
import { chartReach, chartWeight, flagReach, reachersOf } from "../../src/spatial/chart-position";
import type { Reacher } from "../../src/spatial/chart-position";
import type { NodeStore, NodeValues } from "../../src/spatial/node-store";
import { FLAGS } from "../../src/spatial/node-store";
import type { TileCell } from "../../src/spatial/tile-walk";
import { cellsInTile } from "../../src/spatial/tile-walk";

/**
 * The UKC tile drawing by brute force (plan §4.10): every slot of the tile
 * tests every reaching cell, without the cached geometry, the value kinds or
 * the run search. A slot takes the worst of its own cell's class, danger or
 * caution where a reaching cell's P · Φ(−gap/σ) reaches the warn or alert
 * level, and unverified within an unverified cell's flag reach. Gaps are
 * computed as the drawing computes them, in slots, so the two agree to the
 * last bit rather than by tolerance. Equality tests run it beside the drawing.
 */

const UNVERIFIED = FLAGS.NO_COVERAGE | FLAGS.UNASSESSED | FLAGS.NO_DEPTH | FLAGS.NOT_FOR_NAVIGATION;

function classed(v: NodeValues, input: UkcTileInput, bound: boolean): UkcClass | undefined {
  if (v.dMin === -Infinity) {
    if (bound) {
      return v.flags & FLAGS.NO_COVERAGE ? "unverified" : "danger";
    }
    return v.flags & FLAGS.NO_COVERAGE ? undefined : "land";
  }
  if (bound && v.dMin <= input.threshold) {
    return "danger";
  }
  const risk = probabilityBelowZero(
    v.dMin - input.threshold,
    Math.hypot(v.sigmaD, input.sigmaExtra)
  );
  if (risk >= input.thresholds.warn) {
    return "danger";
  }
  if (v.flags & UNVERIFIED) {
    return "unverified";
  }
  if (risk >= input.thresholds.alert) {
    return "caution";
  }
  return input.degraded ? "unverified" : "clear";
}

const RANK = { clear: 0, caution: 1, unverified: 2, danger: 3 } as const;
const BY_RANK = ["clear", "caution", "unverified", "danger"] as const;
const SLOTS = 2 ** DETAIL_ZOOMS;

/** P(UKC < 0) of a reaching depth as a footprint counts it: 1 for a bound at or above the threshold. */
function reachRisk(dMin: number, sigmaD: number, bound: boolean, input: UkcTileInput): number {
  if (dMin === -Infinity || (bound && dMin <= input.threshold)) {
    return 1;
  }
  return probabilityBelowZero(dMin - input.threshold, Math.hypot(sigmaD, input.sigmaExtra));
}

/** The risk sources of a reaching cell: its survey depth and its drawn depth, each with its σ. */
function sources(r: Reacher, input: UkcTileInput): { risk: number; sigma: number }[] {
  const out: { risk: number; sigma: number }[] = [];
  if (r.surveySigma > 0 && r.bathyDMin !== Infinity) {
    out.push({
      risk: reachRisk(r.bathyDMin, r.values.sigmaD, r.bound, input),
      sigma: r.surveySigma
    });
  }
  if (r.topoSigma > 0 && r.topoDMin !== Infinity) {
    out.push({
      risk: reachRisk(r.topoDMin, r.values.sigmaD, r.bound, input),
      sigma: r.topoSigma
    });
  }
  return out;
}

function reachGrid(store: NodeStore, z: number, x: number, y: number, input: UkcTileInput) {
  const tile = tileRect(z, x, y);
  const slot = tileSize(z) / SLOTS;
  const grid = new Uint8Array(SLOTS * SLOTS);
  const { warn, alert } = input.thresholds;
  for (const r of reachersOf(store, tile, z + DETAIL_ZOOMS)) {
    const x0 = (r.rect.minX - tile.minX) / slot;
    const y0 = (tile.maxY - r.rect.maxY) / slot;
    const x1 = (r.rect.maxX - tile.minX) / slot;
    const y1 = (tile.maxY - r.rect.minY) / slot;
    const scale = r.perMetre / slot;
    const flagged = r.surveySigma > 0 && (r.values.flags & UNVERIFIED) !== 0;
    const flags = r.perMetre * flagReach(r.surveySigma);
    const risks = sources(r, input);
    // Slots past REACH_SIGMAS·σ weigh less than RISK_STOP_BELOW, below any level.
    const reach =
      Math.max(chartReach(Math.max(r.surveySigma, r.topoSigma)), flagReach(r.surveySigma)) * scale +
      1;
    const box = (a: number) => Math.max(0, Math.min(SLOTS - 1, Math.floor(a)));
    for (let j = box(y0 - reach); j <= box(y1 + reach); j++) {
      for (let i = box(x0 - reach); i <= box(x1 + reach); i++) {
        const k = j * SLOTS + i;
        if (flagged) {
          const minX = tile.minX + i * slot;
          const maxY = tile.maxY - j * slot;
          const s = { minX, minY: maxY - slot, maxX: minX + slot, maxY };
          if (rectGap(s, r.rect) <= flags) {
            grid[k] = Math.max(grid[k] as number, RANK.unverified);
          }
        }
        const gx = Math.max(0, x0 - (i + 1), i - x1);
        const gy = Math.max(0, y0 - (j + 1), j - y1);
        const gap = Math.hypot(gx, gy) / scale;
        for (const { risk, sigma } of risks) {
          const p = risk * chartWeight(gap, sigma);
          const rank = p >= warn ? RANK.danger : p >= alert ? RANK.caution : 0;
          grid[k] = Math.max(grid[k] as number, rank);
        }
      }
    }
  }
  return grid;
}

/** Rectangles for one cell: whole, or one per slot where something nearby raises it. */
function cellRects(
  c: TileCell,
  cls: UkcClass,
  z: number,
  x: number,
  y: number,
  extent: number,
  grid: Uint8Array
): UkcRect[] {
  const scale = 2 ** (c.z - z);
  const size = extent / scale;
  const x0 = (c.x - x * scale) * size;
  const y0 = (c.y - y * scale) * size;
  const whole = [{ class: cls, x0, y0, x1: x0 + size, y1: y0 + size }];
  if (cls === "land") {
    return whole;
  }
  const own = RANK[cls as keyof typeof RANK];
  const n = SLOTS / scale;
  const si = (c.x - x * scale) * n;
  const sj = (c.y - y * scale) * n;
  let worse = false;
  for (let j = sj; j < sj + n; j++) {
    for (let i = si; i < si + n; i++) {
      worse ||= (grid[j * SLOTS + i] as number) > own;
    }
  }
  if (!worse) {
    return whole;
  }
  const step = extent / SLOTS;
  const out: UkcRect[] = [];
  for (let j = sj; j < sj + n; j++) {
    for (let i = si; i < si + n; i++) {
      const reached = grid[j * SLOTS + i] as number;
      const r: UkcRect = {
        class: BY_RANK[Math.max(own, reached)] as UkcClass,
        x0: i * step,
        y0: j * step,
        x1: (i + 1) * step,
        y1: (j + 1) * step
      };
      if (reached > own) {
        r.reach = true;
      }
      out.push(r);
    }
  }
  return out;
}

/** The tile's rectangles by brute force, sorted by class, reach and position, rows merged. */
export function referenceUkcTile(
  store: NodeStore,
  z: number,
  x: number,
  y: number,
  extent: number,
  input: UkcTileInput
): UkcRect[] {
  const grid = reachGrid(store, z, x, y, input);
  const rects: UkcRect[] = [];
  for (const c of cellsInTile(store, z, x, y, z + DETAIL_ZOOMS)) {
    const cls = classed(c.values, input, c.bound);
    if (cls !== undefined) {
      rects.push(...cellRects(c, cls, z, x, y, extent, grid));
    }
  }
  const key = (r: UkcRect) => `${r.class}${r.reach ? "1" : "0"}`;
  rects.sort((a, b) =>
    key(a) !== key(b) ? (key(a) < key(b) ? -1 : 1) : a.y0 - b.y0 || a.y1 - b.y1 || a.x0 - b.x0
  );
  const merged: UkcRect[] = [];
  for (const r of rects) {
    const last = merged[merged.length - 1];
    if (last && key(last) === key(r) && last.y0 === r.y0 && last.y1 === r.y1 && last.x1 === r.x0) {
      last.x1 = r.x1;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}
