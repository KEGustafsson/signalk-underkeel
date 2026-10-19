import type { Delta, Path, ServerAPI, Unsubscribes } from "@signalk/server-api";
import type { PluginConfig } from "./config";
import { buildEnvelope, EnvelopeTracker } from "./engine/envelope";
import type { LookaheadResult, NavState, Sample } from "./engine/lookahead";
import type { AckStore } from "./ack-store";
import type { Zone } from "./engine/acks";
import { suppress } from "./engine/acks";
import { GroundingDetector } from "./engine/grounding-detect";
import { Hysteresis } from "./engine/hysteresis";
import { evaluateLookahead } from "./engine/lookahead";
import type { UnderKeelNotification } from "./engine/notify";
import { notificationFor } from "./engine/notify";
import type { LonLat } from "./foundation/geo";
import { PATHS } from "./foundation/state";
import type { FetchLike } from "./model/fmi";
import type { IntegrityResult } from "./model/integrity";
import { IntegrityMonitor } from "./model/integrity";
import type { WaterLevel } from "./model/uncertainty";
import type { VesselModel } from "./model/vessel";
import { resolveVessel } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";
import { WFS_NOTICE } from "./ingest/wfs";
import type { WaterLevelStatus } from "./water-level-service";
import { WaterLevelService } from "./water-level-service";
import { ChangeNotifier, groundingNotification, integrityNotification } from "./notifications";

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

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Where each subscribed path lands in NavState and how its value is read. */
const INPUTS: Record<string, { key: keyof NavState; read: (v: unknown) => unknown } | undefined> = {
  "navigation.position": { key: "position", read: (v) => asPosition(v) },
  "navigation.courseOverGroundTrue": { key: "cog", read: (v) => asNumber(v) },
  "navigation.speedOverGround": { key: "sog", read: (v) => asNumber(v) },
  "navigation.headingTrue": { key: "heading", read: (v) => asNumber(v) },
  "navigation.rateOfTurn": { key: "rot", read: (v) => asNumber(v) },
  "navigation.speedThroughWater": { key: "stw", read: (v) => asNumber(v) },
  "navigation.gnss.horizontalDilution": { key: "hdop", read: (v) => asNumber(v) },
  "navigation.gnss.methodQuality": { key: "methodQuality", read: asString },
  "navigation.attitude": {
    key: "roll",
    read: (v) => asNumber((v as { roll?: unknown } | null)?.roll)
  },
  "environment.water.waves.significantHeight": { key: "waveHeight", read: (v) => asNumber(v) }
};

const INPUT_PATHS = Object.keys(INPUTS);

/** The escape fan is searched at most once in this many ms. */
const ESCAPE_EVERY_MS = 3000;

/** Signal K timestamps from the future are clock errors; trust receipt time then. */
const FUTURE_TOLERANCE_MS = 5000;

function sampleTime(timestamp: string | undefined, now: number): number {
  const t = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(t) && t <= now + FUTURE_TOLERANCE_MS ? t : now;
}

function asPosition(v: unknown): LonLat | undefined {
  const p = v as { latitude?: unknown; longitude?: unknown } | null;
  const lat = asNumber(p?.latitude);
  const lon = asNumber(p?.longitude);
  return lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lon, lat]
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
  private readonly levels: WaterLevelService;
  private readonly integrity = new IntegrityMonitor();
  integrityResult?: IntegrityResult;
  private readonly notifier: ChangeNotifier;
  /** notifications.grounding is first written when the detector fires, never before. */
  private everGrounded = false;
  private acks?: AckStore;
  private readonly grounding?: GroundingDetector;
  zones: Zone[] = [];
  private readonly watchers: {
    paths: Set<string>;
    fn: (path: string, value: unknown, at: number) => void;
  }[] = [];
  private readonly hysteresis: Hysteresis;
  /** The escape fan is searched at most this often; the heading is held between. */
  private escape: number | null = null;
  private escapeAt = -Infinity;

  constructor(
    private readonly app: App,
    private readonly pluginId: string,
    private readonly config: PluginConfig,
    private index: ChartIndex | undefined,
    private indexReason: string | undefined,
    private readonly clock: Clock = SYSTEM_CLOCK,
    fetch: FetchLike = globalThis.fetch
  ) {
    this.levels = new WaterLevelService(config, index, fetch);
    this.notifier = new ChangeNotifier(app, pluginId);
    if (config.groundingDetector) {
      this.grounding = new GroundingDetector(config.groundingDetector);
    }
    this.hysteresis = new Hysteresis(config.lookahead.thresholds);
    this.last = this.evaluate();
    this.since = clock.now();
  }

  /** Swaps in a rebuilt index; hysteresis, acks and subscriptions carry over. */
  setIndex(index: ChartIndex): void {
    this.index = index;
    this.indexReason = undefined;
    this.levels.setIndex(index);
  }

  start(): void {
    this.subscribe([
      ...INPUT_PATHS,
      ...this.levels.paths(),
      ...(this.grounding?.paths() ?? []),
      ...this.watchers.flatMap((w) => [...w.paths])
    ]);
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
    this.levels.stop();
    // A raised integrity or grounding notification must not outlive the plugin.
    this.notifier.clear(PATHS.positionIntegrity, "UKC monitoring stopped");
    this.notifier.clear(PATHS.grounding, "UKC monitoring stopped");
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
    this.grounding?.record(path, value, at);
    for (const w of this.watchers) {
      if (w.paths.has(path)) {
        w.fn(path, value, at);
      }
    }
    if (this.levels.record(path, value, at)) {
      return;
    }
    const input = INPUTS[path];
    if (!input) {
      return;
    }
    const v = input.read(value);
    if (v === undefined) {
      delete this.nav[input.key];
    } else {
      (this.nav as Record<string, Sample<unknown>>)[input.key] = { value: v, at };
    }
  }

  /** The vessel as currently resolved from configuration and Signal K. */
  vessel(): VesselModel | undefined {
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

  /**
   * Acknowledged passages and mooring zones act on the published state,
   * after hysteresis: they change the state, not P, so hysteresis would
   * otherwise never let an acknowledged warn go.
   */
  private suppressed(r: LookaheadResult): LookaheadResult {
    const vessel = this.vessel();
    const heading = this.heading();
    if (!vessel || heading === undefined) {
      return r;
    }
    return suppress(r, {
      acks: this.acks?.list(this.clock.now()) ?? [],
      zones: this.zones,
      heading,
      waterLevel: this.waterLevel().h,
      draft: vessel.draft,
      now: this.clock.now(),
      thresholds: this.config.lookahead.thresholds,
      certainWithin: this.config.lookahead.certainWithin
    });
  }

  /** Fresh true heading, else COG; undefined when neither is fresh. */
  heading(): number | undefined {
    const now = this.clock.now();
    const limit = this.config.lookahead.staleAfter * 1000;
    const fresh = (x: Sample<number> | undefined) =>
      x && now - x.at <= limit ? x.value : undefined;
    return fresh(this.nav.heading) ?? fresh(this.nav.cog);
  }

  /** Also subscribes `paths` and hands their values to `fn`, before or after start(). */
  watch(paths: readonly string[], fn: (path: string, value: unknown, at: number) => void): void {
    this.watchers.push({ paths: new Set(paths), fn });
    if (this.timer !== undefined) {
      this.subscribe(paths);
    }
  }

  private subscribe(paths: readonly string[]): void {
    this.app.subscriptionmanager.subscribe(
      {
        context: "vessels.self" as never,
        subscribe: paths.map((path) => ({ path: path as Path, policy: "instant" }))
      },
      this.unsubscribes,
      (err) => this.app.error(`subscription failed: ${String(err)}`),
      (delta) => this.onDelta(delta)
    );
  }

  /** The navigation inputs that are still fresh, for living-chart samples. */
  fresh(): {
    position?: LonLat;
    heading?: number;
    hdop?: number;
    methodQuality?: string;
    roll?: number;
  } {
    const now = this.clock.now();
    const limit = this.config.lookahead.staleAfter * 1000;
    const f = <T>(x: Sample<T> | undefined): T | undefined =>
      x && now - x.at <= limit ? x.value : undefined;
    const n = this.nav;
    return {
      position: f(n.position),
      heading: f(n.heading),
      hdop: f(n.hdop),
      methodQuality: f(n.methodQuality),
      roll: f(n.roll)
    };
  }

  /** Acknowledged passages to honour from now on. */
  useAcks(store: AckStore): void {
    this.acks = store;
  }

  /** Mooring zones to suppress warnings in. */
  setZones(zones: Zone[]): void {
    this.zones = zones;
  }

  /** The water level the engine applies now. */
  waterLevel(): WaterLevel {
    return this.levels.now(this.nav.position?.value, this.clock.now());
  }

  /** The lowest water level over [start, end] (epoch ms), for route checks. */
  waterLevelOver(start: number, end: number): WaterLevel {
    return this.levels.over(start, end, this.clock.now());
  }

  waterLevelStatus(): WaterLevelStatus {
    return this.levels.status(this.nav.position?.value, this.clock.now());
  }

  /** Runs the integrity check on the inputs that are still fresh. */
  private checkIntegrity(now: number): IntegrityResult {
    const fresh = <T>(x: Sample<T> | undefined): T | undefined =>
      x && now - x.at <= this.config.lookahead.staleAfter * 1000 ? x.value : undefined;
    const n = this.nav;
    const result = this.integrity.update(
      {
        position: fresh(n.position),
        heading: fresh(n.heading),
        stw: fresh(n.stw),
        cog: fresh(n.cog),
        sog: fresh(n.sog),
        rot: fresh(n.rot),
        hdop: fresh(n.hdop),
        methodQuality: fresh(n.methodQuality)
      },
      n.position?.at ?? now
    );
    this.integrityResult = result;
    return result;
  }

  private evaluate(): LookaheadResult {
    if (!this.index) {
      return {
        state: "off",
        reason: this.indexReason ?? "no chart index loaded",
        clearance: null,
        clearanceSigma: null,
        risk: null,
        timeToShoal: null,
        escapeHeading: null,
        horizon: 0,
        footprints: []
      };
    }
    const now = this.clock.now();
    const escape = now - this.escapeAt >= ESCAPE_EVERY_MS;
    const r = evaluateLookahead(
      this.nav,
      {
        vessel: this.vessel(),
        dynamics: this.config.dynamics,
        waterLevel: this.waterLevel(),
        positionSigma: this.checkIntegrity(now).sigmaPos,
        escape
      },
      this.index,
      now,
      this.config.lookahead
    );
    if (r.state === "normal" || r.state === "unknown") {
      this.escape = null;
      this.escapeAt = -Infinity;
    } else if (escape) {
      this.escapeAt = now;
      this.escape = r.escapeHeading;
    }
    return { ...r, escapeHeading: this.escape };
  }

  tick(): void {
    this.levels.refresh(this.nav.position?.value, this.clock.now());
    const next = this.suppressed(this.hysteresis.next(this.evaluate()));
    if (next.state !== this.last.state) {
      this.since = this.clock.now();
    }
    this.last = next;
    this.envelope.update(buildEnvelope(this.last, this.config.lookahead.thresholds));
    const r = this.last;
    this.app.handleMessage(this.pluginId, {
      updates: [
        {
          values: [
            { path: PATHS.state as Path, value: r.state },
            { path: PATHS.clearance as Path, value: r.clearance },
            { path: PATHS.clearanceSigma as Path, value: r.clearanceSigma },
            { path: PATHS.risk as Path, value: r.risk },
            { path: PATHS.timeToShoal as Path, value: r.timeToShoal },
            { path: PATHS.escapeHeading as Path, value: r.escapeHeading },
            { path: PATHS.envelopeRev as Path, value: this.envelope.rev },
            { path: PATHS.waterLevel as Path, value: this.waterLevel().h }
          ]
        }
      ]
    });
    this.notify(notificationFor(r));
    if (this.integrityResult) {
      this.notifier.send(PATHS.positionIntegrity, integrityNotification(this.integrityResult));
    }
    this.checkGrounding(r);
    const status =
      r.state === "normal" ? "Monitoring: normal" : `Monitoring: ${r.state} — ${r.reason}`;
    // The WFS licence allows non-navigational use only; say so while it is on.
    this.app.setPluginStatus(
      this.config.wfs && r.reason !== WFS_NOTICE ? `${status} · ${WFS_NOTICE}` : status
    );
  }

  /** Publishes the look-ahead notification only when its state or message changes. */
  notify(n: UnderKeelNotification): void {
    this.notifier.send(PATHS.notification, n);
  }

  /** `notifications.grounding` from the optional detector (safety invariant 7). */
  private checkGrounding(r: LookaheadResult): void {
    if (this.grounding) {
      const draft = this.vessel()?.draft;
      const g = this.grounding.check(this.clock.now(), draft, r.footprints[0]?.risk ?? 0);
      if (g.grounded || this.everGrounded) {
        this.everGrounded = true;
        this.notifier.send(PATHS.grounding, groundingNotification(g));
      }
    }
  }

  private publishMeta(): void {
    this.app.handleMessage(this.pluginId, {
      updates: [
        {
          meta: [
            { path: PATHS.clearance as Path, value: { units: "m" } },
            { path: PATHS.clearanceSigma as Path, value: { units: "m" } },
            { path: PATHS.risk as Path, value: { units: "ratio" } },
            { path: PATHS.timeToShoal as Path, value: { units: "s" } },
            { path: PATHS.escapeHeading as Path, value: { units: "rad" } },
            { path: PATHS.waterLevel as Path, value: { units: "m" } }
          ]
        }
      ]
    });
  }
}
