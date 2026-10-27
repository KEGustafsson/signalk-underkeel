import type { Delta, Path, ServerAPI, Unsubscribes } from "@signalk/server-api";
import type { PluginConfig } from "./config";
import { buildEnvelope, ENVELOPE_DEADBAND, EnvelopeTracker } from "./engine/envelope";
import type { LookaheadInputs, LookaheadResult, NavState, Sample } from "./engine/lookahead";
import type { AckStore } from "./ack-store";
import type { Zone } from "./engine/acks";
import { suppress } from "./engine/acks";
import { GroundingDetector } from "./engine/grounding-detect";
import { Hysteresis } from "./engine/hysteresis";
import { escapeFor, evaluateLookahead } from "./engine/lookahead";
import { notificationFor, notificationKey, NOTIFY_REFRESH_MS } from "./engine/notify";
import type { LonLat } from "./foundation/geo";
import type { RawSounding } from "./livechart/soundings";
import { PATHS, publishable } from "./foundation/state";
import type { FetchLike } from "./model/fmi";
import type { IntegrityResult } from "./model/integrity";
import { IntegrityMonitor } from "./model/integrity";
import type { AreaLevels } from "./model/level-regimes";
import type { WaterLevel } from "./model/uncertainty";
import type { VesselModel } from "./model/vessel";
import { resolveVessel } from "./model/vessel";
import type { ChartIndex } from "./spatial/chart-index";
import { PENDING_REASONS } from "./index-loader";
import { WFS_NOTICE } from "./ingest/wfs";
import type { WaterLevelStatus } from "./water-level-service";
import { WaterLevelService } from "./water-level-service";
import { ChangeNotifier, groundingNotification, integrityUpdate } from "./notifications";
import { asNumber, INPUT_PATHS, NavInputs, sampleTime, selfValue } from "./nav-inputs";
import type { Deferral } from "./escape-search";
import { EscapeSearch } from "./escape-search";
import { LIVENESS, StatusReporter, statusReason, ValuePublisher } from "./tick-publisher";

/**
 * Signal K wiring for the look-ahead: keeps the latest navigation inputs,
 * runs the engine once a second and publishes its deltas and notification.
 */

type App = Pick<
  ServerAPI,
  | "subscriptionmanager"
  | "handleMessage"
  | "getSelfPath"
  | "setPluginStatus"
  | "setPluginError"
  | "error"
>;

export interface Clock extends Deferral {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  defer: (fn) => setImmediate(fn),
  cancel: (h) => clearImmediate(h as NodeJS.Immediate)
};

export class Monitor {
  private readonly inputs = new NavInputs();
  readonly nav: NavState = this.inputs.nav;
  readonly envelope = new EnvelopeTracker();
  last: LookaheadResult;
  /** Epoch ms when the engine entered its current state. */
  since: number;
  vesselNotes: string[] = [];
  private timer: unknown;
  private readonly unsubscribes: Unsubscribes = [];
  /** The server does not merge overlapping subscriptions: each would deliver a delta again. */
  private readonly subscribed = new Set<string>();
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
  private readonly escape: EscapeSearch;
  /** The inputs of the last evaluation, which the escape search after it reuses. */
  private inputsAt?: { inputs: LookaheadInputs; now: number };
  private readonly values: ValuePublisher;
  private readonly status: StatusReporter;

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
    this.hysteresis = new Hysteresis(config.lookahead);
    this.values = new ValuePublisher(app, pluginId, LIVENESS);
    this.status = new StatusReporter(app);
    this.escape = new EscapeSearch(
      clock,
      () => this.searchEscape(),
      (heading) =>
        this.values.send([{ path: PATHS.escapeHeading, value: publishable(heading) }], clock.now())
    );
    this.last = this.evaluate();
    this.since = clock.now();
  }

  /** Swaps in a rebuilt index; hysteresis, acks and subscriptions carry over. */
  setIndex(index: ChartIndex): void {
    this.index = index;
    this.indexReason = undefined;
    this.levels.setIndex(index);
  }

  /** Why there is still no index: being built or read, or failed. The state stays `off`. */
  noIndex(reason: string): void {
    this.indexReason = reason;
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
    this.subscribed.clear();
    this.levels.stop();
    this.escape.stop();
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
        this.record(pv.path, pv.value, at, update.$source);
      }
    }
  }

  private record(path: string, value: unknown, at: number, source: string | undefined): void {
    this.grounding?.record(path, value, at);
    for (const w of this.watchers) {
      if (w.paths.has(path)) {
        w.fn(path, value, at);
      }
    }
    if (!this.levels.record(path, value, at)) {
      this.inputs.record(path, value, at, source);
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
   * otherwise never let an acknowledged warn go. Only acknowledgements hold
   * for a heading; a boat at rest with no heading or COG is still in a zone.
   */
  private suppressed(r: LookaheadResult): LookaheadResult {
    const vessel = this.vessel();
    const heading = this.heading();
    if (!vessel) {
      return r;
    }
    return suppress(r, {
      acks: heading === undefined ? [] : (this.acks?.list(this.clock.now()) ?? []),
      zones: this.zones,
      // With no acknowledgements to match, the heading is never read.
      heading: heading ?? 0,
      waterLevel: this.waterLevel(),
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
    const fresh = [...new Set(paths)].filter((p) => !this.subscribed.has(p));
    if (fresh.length === 0) {
      return;
    }
    fresh.forEach((p) => this.subscribed.add(p));
    this.app.subscriptionmanager.subscribe(
      {
        context: "vessels.self" as never,
        subscribe: fresh.map((path) => ({ path: path as Path, policy: "instant" }))
      },
      this.unsubscribes,
      (err) => this.app.error(`subscription failed: ${String(err)}`),
      (delta) => this.onDelta(delta)
    );
  }

  /** The navigation inputs that are still fresh, for living-chart samples. */
  fresh(): Pick<RawSounding, "position" | "heading" | "hdop" | "methodQuality" | "roll" | "sog"> {
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
      roll: f(n.roll),
      sog: f(n.sog)
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

  /** The lowest water level over [start, end] (epoch ms) at the positions `at`, for route checks. */
  waterLevelOver(start: number, end: number, at: readonly LonLat[]): WaterLevel {
    return this.levels.over(start, end, at, this.clock.now());
  }

  /** The water level over areas now, for UKC tiles and `POST /query`. */
  levelRegimes(): AreaLevels {
    return this.levels.regimes(this.clock.now());
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
    const integrity = this.checkIntegrity(now);
    const inputs: LookaheadInputs = {
      vessel: this.vessel(),
      dynamics: this.config.dynamics,
      waterLevel: this.waterLevel(),
      positionSigma: integrity.sigmaPos,
      positionReason: integrity.reasons.join("; ") || undefined
    };
    this.inputsAt = { inputs, now };
    return evaluateLookahead(this.nav, inputs, this.index, now, this.config.lookahead);
  }

  private searchEscape(): number | null {
    const at = this.inputsAt;
    return at ? escapeFor(this.nav, at.inputs, this.index, at.now, this.config.lookahead) : null;
  }

  tick(): void {
    const t0 = this.clock.now();
    this.levels.refresh(this.nav.position?.value, t0);
    const raw = this.evaluate();
    const escapable = raw.escapable !== false;
    const held = this.hysteresis.next({
      ...raw,
      escapeHeading: this.escape.headingFor(raw.state, escapable)
    });
    // Hysteresis publishes this tick's heading, never a held one; headingFor gives null when
    // the tick is not escapable.
    const next = this.suppressed(held);
    if (next.state !== this.last.state) {
      this.since = this.clock.now();
    }
    this.last = next;
    // A single footprint is the boat below low speed, where only GPS noise moves it.
    const still = this.last.footprints.length === 1 ? ENVELOPE_DEADBAND : 0;
    this.envelope.update(buildEnvelope(this.last, this.config.lookahead.thresholds), still);
    const r = this.last;
    this.values.send(
      [
        { path: PATHS.state, value: r.state },
        { path: PATHS.clearance, value: publishable(r.clearance) },
        { path: PATHS.clearanceSigma, value: publishable(r.clearanceSigma) },
        { path: PATHS.risk, value: publishable(r.risk) },
        { path: PATHS.timeToShoal, value: publishable(r.timeToShoal) },
        { path: PATHS.escapeHeading, value: publishable(r.escapeHeading) },
        { path: PATHS.envelopeRev, value: this.envelope.rev },
        { path: PATHS.waterLevel, value: publishable(this.waterLevel().h) }
      ],
      this.clock.now()
    );
    this.notify(r);
    if (this.integrityResult) {
      const integrity = integrityUpdate(this.integrityResult, this.clock.now());
      this.notifier.send(PATHS.positionIntegrity, integrity.value, integrity.repeat);
    }
    this.checkGrounding(r);
    this.escape.after(raw.state, this.clock.now() - t0, escapable);
    this.report(r);
  }

  private report(r: LookaheadResult): void {
    const now = this.clock.now();
    if (!this.index) {
      // The engine is off either way; a pending reason is a status, any other an error.
      const reason = this.indexReason ?? "no chart index loaded";
      if (PENDING_REASONS.has(reason)) {
        this.status.status(reason, now);
      } else {
        this.status.error(reason, now);
      }
      return;
    }
    const notes = [
      r.state === "normal"
        ? "Monitoring: normal"
        : `Monitoring: ${r.state} — ${statusReason(r.reason)}`,
      // With an index, the reason only says why it was rebuilt or what was skipped.
      this.indexReason,
      this.escape.skipped,
      // The WFS licence allows non-navigational use only; say so while it is on.
      this.config.wfs && r.reason !== WFS_NOTICE ? WFS_NOTICE : undefined
    ];
    this.status.status(notes.filter((n) => n !== undefined).join(" · "), now);
  }

  /**
   * Publishes the look-ahead notification at once when its state, reason or
   * hazard changes, and its countdown at most every NOTIFY_REFRESH_MS.
   */
  notify(r: LookaheadResult): void {
    const repeat = { key: notificationKey(r), refreshMs: NOTIFY_REFRESH_MS, now: this.clock.now() };
    this.notifier.send(PATHS.notification, notificationFor(r), repeat);
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
