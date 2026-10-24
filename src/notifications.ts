import type { Path, ServerAPI } from "@signalk/server-api";
import type { GroundingCheck } from "./engine/grounding-detect";
import type { UnderKeelNotification } from "./engine/notify";
import { NOTIFY_REFRESH_MS } from "./engine/notify";
import { publicReason } from "./foundation/public-text";
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

/** The measurements in an integrity reason that change with every fix; a fix quality does not. */
const DRIFTING = /^(HDOP |GNSS and (?:dead reckoning|water velocity) differ by )\d+(\.\d+)?/;

/**
 * The integrity notification and how it repeats: at once when its state or
 * kind of reason changes, while the divergence and HDOP in the message,
 * which change with every fix, go out at most every NOTIFY_REFRESH_MS.
 */
export function integrityUpdate(
  r: IntegrityResult,
  now: number
): { value: NotificationValue; repeat: Repeat } {
  const value = integrityNotification(r);
  const kind = r.ok
    ? value.message.replace(/\d+(\.\d+)?/g, "#")
    : r.reasons.map((reason) => reason.replace(DRIFTING, "$1#")).join("; ");
  const key = `${value.state}|${kind}`;
  return { value, repeat: { key, refreshMs: NOTIFY_REFRESH_MS, now } };
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

/** How a path's notification is compared with the last one sent. */
export interface Repeat {
  /** Sent at once when it differs from the last one sent. */
  key: string;
  /** A notification with the same key but another message waits this long, ms. */
  refreshMs: number;
  now: number;
}

/**
 * Publishes a notification path only when its state or message changes,
 * or with `repeat`, when its key changes, and its message at most every
 * `refreshMs` while the key holds. Any client can read the notifications,
 * so a message goes out as `publicReason` leaves it: a reason such as
 * "no cells in <dir>" names no server directory there.
 */
export class ChangeNotifier {
  private readonly last = new Map<
    string,
    { state: string; key: string; text: string; at: number }
  >();

  constructor(
    private readonly app: Pick<ServerAPI, "handleMessage">,
    private readonly pluginId: string
  ) {}

  send(path: string, raw: NotificationValue, repeat?: Repeat): void {
    const value = { ...raw, message: publicReason(raw.message) };
    const text = `${value.state}|${value.message}`;
    const key = repeat?.key ?? text;
    const now = repeat?.now ?? 0;
    const last = this.last.get(path);
    const due = last !== undefined && repeat !== undefined && now - last.at >= repeat.refreshMs;
    if (last && last.key === key && (last.text === text || !due)) {
      return;
    }
    this.last.set(path, { state: value.state, key, text, at: now });
    this.app.handleMessage(this.pluginId, {
      updates: [{ values: [{ path: path as Path, value: value as never }] }]
    });
  }

  /** Sets a path this notifier raised back to normal; a path it never wrote stays untouched. */
  clear(path: string, message: string): void {
    const last = this.last.get(path);
    if (last !== undefined && last.state !== "normal") {
      this.send(path, { state: "normal", method: [], message });
    }
  }
}
