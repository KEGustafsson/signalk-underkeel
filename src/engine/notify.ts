import type { UnderKeelState } from "../foundation/state";
import type { LookaheadResult } from "./lookahead";
import { describe } from "./lookahead";

/**
 * `notifications.navigation.underKeel` value (plan §4.10). Look-ahead
 * warnings never use `notifications.grounding` (safety invariant 7).
 * Degraded monitoring is itself raised as an alert, so it is never silent.
 */

export type NotificationState = "normal" | "alert" | "warn" | "alarm";
export type NotificationMethod = "visual" | "sound";

export interface UnderKeelNotification {
  state: NotificationState;
  method: NotificationMethod[];
  message: string;
  data: {
    engineState: UnderKeelState;
    clearance: number | null;
    timeToShoal: number | null;
  };
}

const METHODS: Record<NotificationState, NotificationMethod[]> = {
  normal: [],
  alert: ["visual"],
  warn: ["visual", "sound"],
  alarm: ["visual", "sound"]
};

function notificationState(state: UnderKeelState): NotificationState {
  switch (state) {
    case "normal":
      return "normal";
    case "warn":
      return "warn";
    case "alarm":
      return "alarm";
    default:
      return "alert";
  }
}

function message(result: LookaheadResult): string {
  switch (result.state) {
    case "normal":
      return result.reason === ""
        ? "Under-keel clearance normal"
        : `Under-keel clearance normal (${result.reason})`;
    case "off":
      return `UKC monitoring off: ${result.reason}`;
    case "unknown":
      return `UKC monitoring degraded: ${result.reason}`;
    default:
      return describe(result);
  }
}

export function notificationFor(result: LookaheadResult): UnderKeelNotification {
  const state = notificationState(result.state);
  return {
    state,
    method: METHODS[state],
    message: message(result),
    data: {
      engineState: result.state,
      clearance: result.clearance,
      timeToShoal: result.timeToShoal
    }
  };
}
