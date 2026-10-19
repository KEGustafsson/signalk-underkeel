import type { NodeValues } from "../spatial/node-store";
import type { CellPosterior } from "./posterior";
import type { Sounding } from "./soundings";

/**
 * Checks for the entries of a saved `livechart.json`, and moving its
 * adjustments onto another living-chart zoom.
 */

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const allFinite = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((k) => Number.isFinite(o[k]));

const CELL_NUMBERS = [
  "z",
  "x",
  "y",
  "chartSigma",
  "cellRef",
  "mean",
  "sigma",
  "samples",
  "passes",
  "lastAt"
] as const;

export function isCell(v: unknown): v is CellPosterior {
  return (
    isRecord(v) && allFinite(v, CELL_NUMBERS) && Number.isInteger(v.x) && Number.isInteger(v.y)
  );
}

export function isNodeValues(v: unknown): v is NodeValues {
  return (
    isRecord(v) &&
    allFinite(v, ["dMin", "sigmaD", "sigmaP", "cellRef"]) &&
    Number.isInteger(v.flags)
  );
}

/** The ECMAScript Date range, ms: a sample outside it cannot be exported. */
const MAX_TIME = 8.64e15;

export function isSounding(v: unknown): v is Sounding {
  return (
    isRecord(v) &&
    allFinite(v, ["at", "belowSurface", "depth", "sigma"]) &&
    Math.abs(v.at as number) <= MAX_TIME &&
    Array.isArray(v.position) &&
    v.position.length === 2 &&
    v.position.every((n) => Number.isFinite(n))
  );
}

/**
 * The tiles at zoom `to` that tile `key` at zoom `from` covers or lies in:
 * its parent when `to` is coarser, every child when it is finer.
 */
export function tilesAt(key: number, from: number, to: number): { x: number; y: number }[] {
  const n = 2 ** from;
  const x = Math.floor(key / n);
  const y = key % n;
  if (to <= from) {
    const k = 2 ** (from - to);
    return [{ x: Math.floor(x / k), y: Math.floor(y / k) }];
  }
  const k = 2 ** (to - from);
  const out: { x: number; y: number }[] = [];
  for (let dx = 0; dx < k; dx++) {
    for (let dy = 0; dy < k; dy++) {
      out.push({ x: x * k + dx, y: y * k + dy });
    }
  }
  return out;
}

/** Two adjustments for one cell as one: the shallower depth and the larger σ (invariant 5). */
export function mergeAdjustments(a: NodeValues | undefined, b: NodeValues): NodeValues {
  return a
    ? {
        dMin: Math.min(a.dMin, b.dMin),
        sigmaD: Math.max(a.sigmaD, b.sigmaD),
        sigmaP: Math.max(a.sigmaP, b.sigmaP),
        flags: a.flags | b.flags,
        cellRef: b.cellRef
      }
    : b;
}
