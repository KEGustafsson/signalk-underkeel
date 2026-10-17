/** Engine states published on `navigation.underKeel.state`. */
export type UnderKeelState = "normal" | "alert" | "warn" | "alarm" | "unknown" | "off";

export const PATHS = {
  state: "navigation.underKeel.state",
  notification: "notifications.navigation.underKeel"
} as const;

export interface EngineStatus {
  state: UnderKeelState;
  /** Why the engine is in this state; always set when state is not "normal". */
  reason: string;
  since: string;
}

export function createStatus(state: UnderKeelState, reason: string, now: Date): EngineStatus {
  return { state, reason, since: now.toISOString() };
}
