import type { BoxSize, SizingInput } from "./box-sizing";
import { buildMsAt } from "./box-sizing";
import { spoken } from "./engine/chart-box";
import type { BuildPhase, BuildProgress } from "./spatial/build-progress";

/**
 * What the chart box service says about a rebuild in progress and the box's size, in
 * `GET /status` (`chartBox`), the plugin status line and the details panel.
 */

/** A box build in progress, as the service keeps it. */
export interface RunningBuild {
  startedAt: number;
  radiusKm: number;
  /** The last build's duration grown to this box's area; absent before one was measured. */
  estimateMs?: number;
  progress?: BuildProgress;
}

/** The box build in progress, as `GET /status` gives it. */
export interface BoxRebuild {
  startedAt: string;
  elapsedMs: number;
  radiusKm: number;
  /** The last progress the build posted; absent until its first. */
  phase?: BuildPhase;
  done?: number;
  total?: number;
  estimateMs?: number;
}

/** The radius the next box gets at the current speed (`box-sizing.ts`), the cap and the speed. */
export type BoxSizing = BoxSize & { capKm: number; sog: number };

export function rebuildStatus(r: RunningBuild, now: number): BoxRebuild {
  return {
    startedAt: new Date(r.startedAt).toISOString(),
    elapsedMs: now - r.startedAt,
    radiusKm: r.radiusKm,
    ...r.progress,
    ...(r.estimateMs === undefined ? {} : { estimateMs: r.estimateMs })
  };
}

function phaseText(r: BoxRebuild): string {
  const of = r.done !== undefined && r.total !== undefined ? ` ${r.done}/${r.total}` : "";
  switch (r.phase) {
    case "download":
      return "downloading WFS depths";
    case "cells":
      return `reading cells${of}`;
    case "roots":
      return `building roots${of}`;
    case "save":
      return "saving the index";
    default:
      return "starting";
  }
}

function rebuildText(r: BoxRebuild, lastMs: number | undefined): string {
  const expected =
    r.estimateMs === undefined
      ? "first build"
      : r.estimateMs === lastMs
        ? `last build took ${spoken(r.estimateMs)}`
        : `about ${spoken(r.estimateMs)} expected`;
  const ago = spoken(r.elapsedMs);
  return `chart box rebuilding (${r.radiusKm} km): ${phaseText(r)}, started ${ago} ago, ${expected}`;
}

function tooSmallText(s: BoxSizing, i: SizingInput): string {
  const kn = ((s.sog * 3600) / 1852).toFixed(1);
  const builds = spoken(buildMsAt(s.radiusKm, i));
  const need =
    s.neededKm === undefined
      ? "no box size keeps up"
      : `needs ${s.neededKm} km, limit ${s.capKm} km`;
  return `chart box ${s.radiusKm} km is too small for ${kn} kn with ${builds} builds: ${need}`;
}

/** One line on the rebuild in progress and the box size; undefined when neither needs saying. */
export function boxSummary(s: {
  rebuild?: BoxRebuild;
  lastMs?: number;
  sizing: BoxSizing;
  input: SizingInput;
  ceilingKm?: number;
}): string | undefined {
  const parts: string[] = [];
  if (s.rebuild) {
    parts.push(rebuildText(s.rebuild, s.lastMs));
  }
  if (!s.sizing.enough) {
    parts.push(tooSmallText(s.sizing, s.input));
  }
  if (s.ceilingKm !== undefined) {
    parts.push(`chart box limited to ${s.ceilingKm} km: a larger one ran out of memory`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}
