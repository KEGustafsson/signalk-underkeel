import type { Path, ServerAPI } from "@signalk/server-api";

/**
 * The look-ahead's per-tick output, sent only when it changes. Most values
 * repeat from one second to the next (81 % on a 6 kn test route), and each
 * delta is fanned out to every subscriber and history writer.
 */

/** Every value is sent at least this often, for subscribers that joined since. */
export const KEEP_ALIVE_MS = 10_000;

export interface PathValue {
  path: string;
  value: unknown;
}

/**
 * Sends the values that changed since they were last sent, and the paths in
 * `always` every time: the state, so a client can tell the plugin is
 * running, and the envelope rev clients fetch on. A value unchanged for
 * KEEP_ALIVE_MS is sent again.
 */
export class ValuePublisher {
  private readonly sent = new Map<string, { json: string; at: number }>();

  constructor(
    private readonly app: Pick<ServerAPI, "handleMessage">,
    private readonly pluginId: string,
    private readonly always: ReadonlySet<string>
  ) {}

  send(values: PathValue[], now: number): void {
    const out = values.filter((v) => {
      const json = JSON.stringify(v.value);
      const last = this.sent.get(v.path);
      const due =
        last === undefined ||
        last.json !== json ||
        now - last.at >= KEEP_ALIVE_MS ||
        this.always.has(v.path);
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

/** `setPluginStatus` and `setPluginError`, called only when the text changes. */
export class StatusReporter {
  private last?: string;

  constructor(private readonly app: Pick<ServerAPI, "setPluginStatus" | "setPluginError">) {}

  status(text: string): void {
    if (this.last !== `status|${text}`) {
      this.last = `status|${text}`;
      this.app.setPluginStatus(text);
    }
  }

  error(text: string): void {
    if (this.last !== `error|${text}`) {
      this.last = `error|${text}`;
      this.app.setPluginError(text);
    }
  }
}
