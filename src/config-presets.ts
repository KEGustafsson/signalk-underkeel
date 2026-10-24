import { DEFAULT_LOOKAHEAD } from "./engine/lookahead";

/**
 * The warning style stands in for the look-ahead thresholds, windows and
 * distance. An expert value set in the configuration overrides the style's
 * value for that field alone.
 */

export const WARNING_STYLES = ["early", "balanced", "late"] as const;
export type WarningStyle = (typeof WARNING_STYLES)[number];

export interface WarningPreset {
  /** Look-ahead distance, metres. */
  distance: number;
  alertRisk: number;
  warnRisk: number;
  alarmRisk: number;
  /** Seconds. */
  warnWithin: number;
  alarmWithin: number;
  certainWithin: number;
}

const BALANCED: WarningPreset = {
  distance: DEFAULT_LOOKAHEAD.distance,
  alertRisk: DEFAULT_LOOKAHEAD.thresholds.alert,
  warnRisk: DEFAULT_LOOKAHEAD.thresholds.warn,
  alarmRisk: DEFAULT_LOOKAHEAD.thresholds.alarm,
  warnWithin: DEFAULT_LOOKAHEAD.warnWithin,
  alarmWithin: DEFAULT_LOOKAHEAD.alarmWithin,
  certainWithin: DEFAULT_LOOKAHEAD.certainWithin
};

/**
 * Balanced is the earlier defaults. Early is at least as cautious as
 * Balanced in every field and Late at most as cautious; all three keep the
 * 30 s alarm on a negative mean clearance.
 */
export const WARNING_PRESETS: Record<WarningStyle, WarningPreset> = {
  early: {
    distance: 0.5 * 1852,
    alertRisk: 0.005,
    warnRisk: 0.02,
    alarmRisk: 0.1,
    warnWithin: 180,
    alarmWithin: 90,
    certainWithin: BALANCED.certainWithin
  },
  balanced: BALANCED,
  late: {
    distance: 0.2 * 1852,
    alertRisk: 0.02,
    warnRisk: 0.1,
    alarmRisk: 0.3,
    warnWithin: 90,
    alarmWithin: 45,
    certainWithin: BALANCED.certainWithin
  }
};

export function warningStyle(v: unknown): WarningStyle {
  return WARNING_STYLES.find((s) => s === v) ?? "balanced";
}
