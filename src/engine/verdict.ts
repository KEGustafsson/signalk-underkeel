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

export function classify(fps: FootprintResult[], opts: LookaheadOptions): Verdict {
  const th = opts.thresholds;
  const alarm = fps.find(
    (f) =>
      (f.t <= opts.alarmWithin && f.risk >= th.alarm) ||
      (f.t <= opts.certainWithin && f.mean !== null && f.mean < 0)
  );
  const warn = fps.find((f) => f.risk >= th.warn);
  const tts = warn ? warn.t : null;
  if (alarm) {
    const reason = alarm.t === 0 ? "shoal under the vessel" : `shoal ahead in ${inS(alarm.t)}`;
    return { state: "alarm", reason, tts: tts ?? alarm.t };
  }
  if (warn && tts !== null && tts <= opts.warnWithin) {
    // At a coverage edge the risk comes from the gap's unassessed σ, so say so.
    const gap = ((warn.riskTile?.flags ?? 0) & FLAGS.NO_COVERAGE) !== 0;
    const what = gap ? "no chart coverage" : "shoal";
    return { state: "warn", reason: `${what} ahead in ${inS(tts)}`, tts };
  }
  const uncovered = fps.find((f) => f.uncovered);
  if (uncovered) {
    const where = uncovered.t === 0 ? "at the vessel" : `ahead in ${inS(uncovered.t)}`;
    return { state: "warn", reason: `no chart coverage ${where}`, tts };
  }
  const alert = fps.find((f) => f.risk >= th.alert);
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
