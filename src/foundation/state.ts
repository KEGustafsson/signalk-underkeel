/** Engine states published on `navigation.underKeel.state`. */
export type UnderKeelState = "normal" | "alert" | "warn" | "alarm" | "unknown" | "off";

/** Signal K paths the plugin publishes (plan §4.10). */
export const PATHS = {
  state: "navigation.underKeel.state",
  clearance: "navigation.underKeel.clearance",
  clearanceSigma: "navigation.underKeel.clearanceSigma",
  risk: "navigation.underKeel.risk",
  timeToShoal: "navigation.underKeel.timeToShoal",
  escapeHeading: "navigation.underKeel.escapeHeading",
  envelopeRev: "navigation.underKeel.envelopeRev",
  waterLevel: "navigation.underKeel.waterLevel",
  notification: "notifications.navigation.underKeel",
  positionIntegrity: "notifications.navigation.positionIntegrity"
} as const;

export interface EngineStatus {
  state: UnderKeelState;
  /** Why the engine is in this state; always set when state is not "normal". */
  reason: string;
  since: string;
}

/** Engine status stamped with the time it was entered. */
export function createStatus(state: UnderKeelState, reason: string, now: Date): EngineStatus {
  return { state, reason, since: now.toISOString() };
}
