import type { Path, ServerAPI } from "@signalk/server-api";
import type { GroundingCheck } from "./engine/grounding-detect";
import type { UnderKeelNotification } from "./engine/notify";
import type { IntegrityResult } from "./model/integrity";

/** Notification values the plugin publishes beside the look-ahead's own. */

export interface NotificationValue {
  state: string;
  method: string[];
  message: string;
  data?: Record<string, unknown>;
}

export function integrityNotification(r: IntegrityResult): NotificationValue {
  return {
    state: r.ok ? "normal" : "warn",
    method: r.ok ? [] : ["visual", "sound"],
    message: r.ok
      ? `Position integrity: ${r.unchecked ?? "GNSS agrees with dead reckoning"}`
      : `Position integrity degraded: ${r.reasons.join("; ")}`,
    data: { sigmaPos: r.sigmaPos, divergence: r.divergence }
  };
}

export function groundingNotification(g: GroundingCheck): NotificationValue {
  return g.grounded
    ? {
        state: "emergency",
        method: ["visual", "sound"],
        message: `Grounding detected: ${g.reasons.join("; ")}`
      }
    : { state: "normal", method: [], message: "Grounding alarm cleared: under way again" };
}

/** The look-ahead notification once the plugin stops: nothing is monitored, so nothing is raised. */
export function stoppedNotification(): UnderKeelNotification {
  return {
    state: "normal",
    method: [],
    message: "UKC monitoring stopped",
    data: {
      engineState: "off",
      clearance: null,
      clearanceSigma: null,
      risk: null,
      timeToShoal: null
    }
  };
}

/** Publishes a notification path only when its state or message changes. */
export class ChangeNotifier {
  private readonly last = new Map<string, string>();

  constructor(
    private readonly app: Pick<ServerAPI, "handleMessage">,
    private readonly pluginId: string
  ) {}

  send(path: string, value: NotificationValue): void {
    const key = `${value.state}|${value.message}`;
    if (this.last.get(path) === key) {
      return;
    }
    this.last.set(path, key);
    this.app.handleMessage(this.pluginId, {
      updates: [{ values: [{ path: path as Path, value: value as never }] }]
    });
  }

  /** Sets a path this notifier raised back to normal; a path it never wrote stays untouched. */
  clear(path: string, message: string): void {
    const last = this.last.get(path);
    if (last !== undefined && !last.startsWith("normal|")) {
      this.send(path, { state: "normal", method: [], message });
    }
  }
}
