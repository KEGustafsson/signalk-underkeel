import type { UnderKeelState } from "../foundation/state";
import type { Explanation } from "./explain";
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
    clearanceSigma: number | null;
    risk: number | null;
    timeToShoal: number | null;
    /** The worst point's terms (plan §4.10: `data.explanation`). */
    explanation?: Explanation;
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
      clearanceSigma: result.clearanceSigma,
      risk: result.risk,
      timeToShoal: result.timeToShoal,
      explanation: result.worst?.explanation
    }
  };
}

/**
 * What a new look-ahead notification must go out for at once: its state,
 * the engine state, the kind of reason and the hazard named. The seconds
 * to shoal and the terms in the message change every tick and are sent
 * at most every NOTIFY_REFRESH_MS while these hold.
 */
export function notificationKey(result: LookaheadResult): string {
  const hazard = result.worst?.explanation.hazard;
  return [
    notificationState(result.state),
    result.state,
    result.reason.replace(/\d+(\.\d+)?/g, "#"),
    hazard ? `${hazard.class} ${hazard.lnam ?? ""}` : ""
  ].join("|");
}

/** The message of an unchanged look-ahead notification is refreshed this often, ms. */
export const NOTIFY_REFRESH_MS = 30_000;
