import type { Delta, Path, ServerAPI, Unsubscribes } from "@signalk/server-api";
import type { PluginConfig } from "./config";
import { buildEnvelope, EnvelopeTracker } from "./engine/envelope";
import type { LookaheadResult, NavState, Sample } from "./engine/lookahead";
import { evaluateLookahead } from "./engine/lookahead";
import type { UnderKeelNotification } from "./engine/notify";
import { notificationFor } from "./engine/notify";
import type { LonLat } from "./foundation/geo";
import { PATHS } from "./foundation/state";
import type { VesselModel } from "./model/vessel";
import { resolveVessel } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";

/**
 * Signal K wiring for the look-ahead: keeps the latest navigation inputs,
 * runs the engine once a second and publishes its deltas and notification.
 */

type App = Pick<
  ServerAPI,
  "subscriptionmanager" | "handleMessage" | "getSelfPath" | "setPluginStatus" | "error"
>;

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
};

const INPUT_PATHS = [
  "navigation.position",
  "navigation.courseOverGroundTrue",
  "navigation.speedOverGround",
  "navigation.headingTrue"
] as const;

/** Signal K timestamps from the future are clock errors; trust receipt time then. */
const FUTURE_TOLERANCE_MS = 5000;

function sampleTime(timestamp: string | undefined, now: number): number {
  const t = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(t) && t <= now + FUTURE_TOLERANCE_MS ? t : now;
}

function asPosition(v: unknown): LonLat | undefined {
  const p = v as { latitude?: unknown; longitude?: unknown } | null;
  return p && typeof p.latitude === "number" && typeof p.longitude === "number"
    ? [p.longitude, p.latitude]
    : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** `getSelfPath` returns the full node; the reading is under `.value`. */
function selfValue(app: App, path: string): unknown {
  const node = app.getSelfPath(path) as { value?: unknown } | undefined;
  return node && typeof node === "object" && "value" in node ? node.value : node;
}

export class Monitor {
  readonly nav: NavState = {};
  readonly envelope = new EnvelopeTracker();
  last: LookaheadResult;
  /** Epoch ms when the engine entered its current state. */
  since: number;
  vesselNotes: string[] = [];
  private timer: unknown;
  private readonly unsubscribes: Unsubscribes = [];
  private lastNotification = "";

  constructor(
    private readonly app: App,
    private readonly pluginId: string,
    private readonly config: PluginConfig,
    private readonly index: ChartIndex | undefined,
    private readonly indexReason: string | undefined,
    private readonly clock: Clock = SYSTEM_CLOCK
  ) {
    this.last = this.evaluate();
    this.since = clock.now();
  }

  start(): void {
    this.app.subscriptionmanager.subscribe(
      {
        context: "vessels.self" as never,
        subscribe: INPUT_PATHS.map((path) => ({ path: path as Path, policy: "instant" }))
      },
      this.unsubscribes,
      (err) => this.app.error(`subscription failed: ${String(err)}`),
      (delta) => this.onDelta(delta)
    );
    this.publishMeta();
    this.tick();
    this.timer = this.clock.setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const u of this.unsubscribes.splice(0)) {
      u();
    }
  }

  onDelta(delta: Delta): void {
    const now = this.clock.now();
    for (const update of delta.updates) {
      if (!("values" in update)) {
        continue;
      }
      const at = sampleTime(update.timestamp, now);
      for (const pv of update.values) {
        this.record(pv.path, pv.value, at);
      }
    }
  }

  private record(path: string, value: unknown, at: number): void {
    const set = <T>(key: keyof NavState, v: T | undefined) => {
      if (v === undefined) {
        delete this.nav[key];
      } else {
        (this.nav as Record<string, Sample<T>>)[key] = { value: v, at };
      }
    };
    switch (path) {
      case "navigation.position":
        set("position", asPosition(value));
        break;
      case "navigation.courseOverGroundTrue":
        set("cog", asNumber(value));
        break;
      case "navigation.speedOverGround":
        set("sog", asNumber(value));
        break;
      case "navigation.headingTrue":
        set("heading", asNumber(value));
        break;
    }
  }

  private vessel(): VesselModel | undefined {
    const draft = selfValue(this.app, "design.draft") as { maximum?: unknown } | undefined;
    const length = selfValue(this.app, "design.length") as { overall?: unknown } | undefined;
    const resolved = resolveVessel({
      config: this.config.vessel,
      signalk: {
        draft: asNumber(draft?.maximum),
        length: asNumber(length?.overall),
        beam: asNumber(selfValue(this.app, "design.beam"))
      }
    });
    this.vesselNotes = resolved.notes;
    return resolved.vessel;
  }

  private evaluate(): LookaheadResult {
    if (!this.index) {
      return {
        state: "off",
        reason: this.indexReason ?? "no chart index loaded",
        clearance: null,
        timeToShoal: null,
        horizon: 0,
        footprints: []
      };
    }
    return evaluateLookahead(
      this.nav,
      this.vessel(),
      this.index,
      this.clock.now(),
      this.config.lookahead
    );
  }

  tick(): void {
    const next = this.evaluate();
    if (next.state !== this.last.state) {
      this.since = this.clock.now();
    }
    this.last = next;
    this.envelope.update(buildEnvelope(this.last));
    const r = this.last;
    this.app.handleMessage(this.pluginId, {
      updates: [
        {
          values: [
            { path: PATHS.state as Path, value: r.state },
            { path: PATHS.clearance as Path, value: r.clearance },
            { path: PATHS.timeToShoal as Path, value: r.timeToShoal },
            { path: PATHS.envelopeRev as Path, value: this.envelope.rev },
            // Milestone M1 has no water-level provider: depths are at chart datum.
            { path: PATHS.waterLevel as Path, value: 0 }
          ]
        }
      ]
    });
    this.notify(notificationFor(r));
    this.app.setPluginStatus(
      r.state === "normal" ? "Monitoring: normal" : `Monitoring: ${r.state} — ${r.reason}`
    );
  }

  /** Publishes the notification only when its state or message changes. */
  notify(n: UnderKeelNotification): void {
    const key = `${n.state}|${n.message}`;
    if (key === this.lastNotification) {
      return;
    }
    this.lastNotification = key;
    this.app.handleMessage(this.pluginId, {
      updates: [{ values: [{ path: PATHS.notification as Path, value: n as never }] }]
    });
  }

  private publishMeta(): void {
    this.app.handleMessage(this.pluginId, {
      updates: [
        {
          meta: [
            { path: PATHS.clearance as Path, value: { units: "m" } },
            { path: PATHS.timeToShoal as Path, value: { units: "s" } },
            { path: PATHS.waterLevel as Path, value: { units: "m" } }
          ]
        }
      ]
    });
  }
}
