import type { UnderKeelState } from "../foundation/state";
import { WFS_NOTICE } from "../ingest/wfs";
import type { WaterLevel } from "../model/uncertainty";
import { FLAGS } from "../spatial/node-store";
import type { Motion } from "./fan";
import type { FootprintResult, LookaheadOptions } from "./lookahead";

/** The look-ahead state table (plan §4.7) over one tick's footprints. */

export interface Verdict {
  state: UnderKeelState;
  reason: string;
  tts: number | null;
}

const inS = (t: number): string => `${t.toFixed(0)} s`;

/** Reads a tick's footprints as if every step had been scored with a full chart walk. */
export interface Refine {
  /**
   * The first second footprint i's condition holds: its own t, or a skipped
   * step before it when it is a coarse footprint beyond the warn window.
   */
  firstTime(i: number, holds: (f: FootprintResult) => boolean): number;
  /** Footprint i with every tile in reach read, for its coverage. */
  complete(i: number): FootprintResult;
}

function plain(fps: FootprintResult[]): Refine {
  return {
    firstTime: (i) => (fps[i] as FootprintResult).t,
    complete: (i) => fps[i] as FootprintResult
  };
}

/**
 * Risk decides first, so a footprint whose walk stopped at certain land is
 * read in full only where the state turns on coverage.
 */
export function classify(
  fps: FootprintResult[],
  opts: LookaheadOptions,
  refine: Refine = plain(fps)
): Verdict {
  const th = opts.thresholds;
  const alarm = fps.find(
    (f) =>
      (f.t <= opts.alarmWithin && f.risk >= th.alarm) ||
      (f.t <= opts.certainWithin && f.mean !== null && f.mean < 0)
  );
  const first = (holds: (f: FootprintResult) => boolean, full = false) => {
    for (let i = 0; i < fps.length; i++) {
      const f = full ? refine.complete(i) : (fps[i] as FootprintResult);
      if (holds(f)) {
        return { f, t: refine.firstTime(i, holds) };
      }
    }
    return undefined;
  };
  const warn = first((f) => f.risk >= th.warn);
  const tts = warn?.t ?? null;
  if (alarm) {
    const reason = alarm.t === 0 ? "shoal under the vessel" : `shoal ahead in ${inS(alarm.t)}`;
    return { state: "alarm", reason, tts: tts ?? alarm.t };
  }
  if (warn && warn.t <= opts.warnWithin) {
    // At a coverage edge the risk comes from the gap's unassessed σ, so say so.
    const gap = ((warn.f.riskTile?.flags ?? 0) & FLAGS.NO_COVERAGE) !== 0;
    const what = gap ? "no chart coverage" : "shoal";
    return { state: "warn", reason: `${what} ahead in ${inS(warn.t)}`, tts };
  }
  const uncovered = first((f) => f.uncovered, true);
  if (uncovered) {
    const where = uncovered.t === 0 ? "at the vessel" : `ahead in ${inS(uncovered.t)}`;
    return { state: "warn", reason: `no chart coverage ${where}`, tts };
  }
  const alert = first((f) => f.risk >= th.alert);
  if (alert) {
    return { state: "alert", reason: `shoal risk ahead in ${inS(alert.t)}`, tts };
  }
  return { state: "normal", reason: "", tts: null };
}

/**
 * A clear answer is downgraded when it rests on less than full input:
 * without course and speed only the vessel's own footprint is checked
 * (`unknown`), and a fallback water level is published as an alert.
 */
export function degrade(c: Verdict, m: Motion, wl: WaterLevel, fps: FootprintResult[]): Verdict {
  if (c.state !== "normal") {
    return c;
  }
  if (!m.known) {
    return {
      ...c,
      state: "unknown",
      reason: "course or speed stale: only the current position is checked"
    };
  }
  if (wl.degraded) {
    return { ...c, state: "alert", reason: wl.degraded };
  }
  // Depths from an advisory source lack rocks and survey quality: never normal.
  if (fps.some((f) => f.flags & FLAGS.NOT_FOR_NAVIGATION)) {
    return { ...c, state: "alert", reason: WFS_NOTICE };
  }
  if (!m.moving) {
    return { ...c, reason: "low speed: only the current position is checked" };
  }
  return c;
}

/**
 * With the buffer capped (MAX_POSITION_BUFFER) the chart beyond it is not
 * read, so a footprint may miss a shoal the position could be over: the
 * state is at least warn, with the integrity monitor's reason.
 */
export function uncertainPosition(c: Verdict, sigmaPos: number, why?: string): Verdict {
  if (c.state === "warn" || c.state === "alarm") {
    return c;
  }
  const position = `position uncertainty ${sigmaPos.toFixed(0)} m${why ? `: ${why}` : ""}`;
  // A stale course or a fallback water level still needs saying beside it.
  return { ...c, state: "warn", reason: c.reason ? `${position}; ${c.reason}` : position };
}
