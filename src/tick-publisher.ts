import type { Path, ServerAPI } from "@signalk/server-api";
import { PATHS } from "./foundation/state";

/**
 * The look-ahead's per-tick output, sent only when it changes. Most values
 * repeat from one second to the next (81 % on a 6 kn test route), and each
 * delta is fanned out to every subscriber and history writer.
 */

/** Every value is sent at least this often, for subscribers that joined since. */
export const KEEP_ALIVE_MS = 10_000;

/**
 * `navigation.underKeel.state` and `.envelopeRev` are sent at least this often. A client
 * treats them as stale after LIVENESS_STALE_MS without one (docs/HOW-IT-WORKS.md).
 */
export const LIVENESS_KEEP_ALIVE_MS = 5_000;

/** Three missed liveness keep-alives: how long a client waits before it shows unknown. */
export const LIVENESS_STALE_MS = 3 * LIVENESS_KEEP_ALIVE_MS;

/**
 * Sent on change and at least every LIVENESS_KEEP_ALIVE_MS: the state shows the plugin is
 * alive, and clients fetch on a new rev. Sending them every tick wrote two history points a
 * second at the dock.
 */
export const LIVENESS: ReadonlyMap<string, number> = new Map([
  [PATHS.state, LIVENESS_KEEP_ALIVE_MS],
  [PATHS.envelopeRev, LIVENESS_KEEP_ALIVE_MS]
]);

export interface PathValue {
  path: string;
  value: unknown;
}

/**
 * Sends the values that changed since they were last sent. A value unchanged
 * for its keep-alive is sent again: `keepAlive` names the paths with another
 * one than KEEP_ALIVE_MS, such as the state, whose arrival tells a client the
 * plugin is running.
 */
export class ValuePublisher {
  private readonly sent = new Map<string, { json: string; at: number }>();

  constructor(
    private readonly app: Pick<ServerAPI, "handleMessage">,
    private readonly pluginId: string,
    private readonly keepAlive: ReadonlyMap<string, number> = new Map()
  ) {}

  send(values: PathValue[], now: number): void {
    const out = values.filter((v) => {
      const json = JSON.stringify(v.value);
      const last = this.sent.get(v.path);
      const due =
        last === undefined ||
        last.json !== json ||
        now - last.at >= (this.keepAlive.get(v.path) ?? KEEP_ALIVE_MS);
      if (due) {
        this.sent.set(v.path, { json, at: now });
      }
      return due;
    });
    if (out.length > 0) {
      this.app.handleMessage(this.pluginId, {
        updates: [{ values: out.map((v) => ({ path: v.path as Path, value: v.value as never })) }]
      });
    }
  }
}

/** A status that differs from the one shown only in its numbers waits this long, ms. */
export const STATUS_REFRESH_MS = 30_000;

/**
 * A look-ahead reason as the plugin status shows it: without the seconds to shoal, which
 * change every tick in the warn zone. `GET /status` keeps them, in `engine.reason` and
 * `lookahead.timeToShoal`.
 */
export function statusReason(reason: string): string {
  return reason.replace(/ in \d+(\.\d+)? (s|min)\b/g, "");
}

/**
 * `setPluginStatus` and `setPluginError`, called only when the text changes. A status
 * whose words are unchanged and only its numbers moved (an HDOP, a tick's duration) is set
 * again at most every STATUS_REFRESH_MS; a change of words is set at once.
 */
export class StatusReporter {
  private last?: { kind: "status" | "error"; text: string; words: string; at: number };

  constructor(private readonly app: Pick<ServerAPI, "setPluginStatus" | "setPluginError">) {}

  status(text: string, now: number): void {
    if (this.due("status", text, now)) {
      this.app.setPluginStatus(text);
    }
  }

  error(text: string, now: number): void {
    if (this.due("error", text, now)) {
      this.app.setPluginError(text);
    }
  }

  private due(kind: "status" | "error", text: string, now: number): boolean {
    const last = this.last;
    const words = text.replace(/\d+(\.\d+)?/g, "#");
    if (last?.kind === kind) {
      if (last.text === text) {
        return false;
      }
      if (last.words === words && now - last.at < STATUS_REFRESH_MS) {
        return false;
      }
    }
    this.last = { kind, text, words, at: now };
    return true;
  }
}
