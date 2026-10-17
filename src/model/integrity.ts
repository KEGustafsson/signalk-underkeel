import type { LonLat } from "../foundation/geo";
import { haversine, project } from "../foundation/geo";
import { gnssSigma } from "./position";

/**
 * Position integrity (plan §4.8). Dead reckoning from heading, speed
 * through water and a learned current runs beside GNSS; a fix that leaves
 * the DR position by more than k · σ_DR, a fix that is not a satellite fix,
 * or HDOP above 4 inflates σ_pos and raises a reason. Without speed through
 * water there is nothing independent to check against, which is reported
 * too.
 */

export interface IntegrityInputs {
  position?: LonLat;
  /** True heading, radians. */
  heading?: number;
  /** Speed through water, m/s. */
  stw?: number;
  /** Course and speed over ground, radians and m/s. */
  cog?: number;
  sog?: number;
  /** Rate of turn, rad/s. */
  rot?: number;
  hdop?: number;
  /** `navigation.gnss.methodQuality`. */
  methodQuality?: string;
}

export interface IntegrityResult {
  /** 1σ position uncertainty to apply, metres. */
  sigmaPos: number;
  ok: boolean;
  /** Why σ was inflated; empty when ok. */
  reasons: string[];
  /** GNSS minus DR distance, metres; null when DR is not running. */
  divergence: number | null;
  /** Set when the DR check cannot run. */
  unchecked?: string;
}

export interface IntegrityOptions {
  /** Divergence beyond k · σ_DR is a failure. */
  k: number;
  /** Growth of the DR error per second run, m/s (heading, log and current error). */
  sigmaVelocity: number;
  /** A consistent DR run is re-anchored on GNSS after this many seconds. */
  window: number;
  /** Low-pass time constant of the current estimate, seconds. */
  currentTau: number;
  /** HDOP above this inflates σ_pos and is reported. */
  maxHdop: number;
  /** σ_pos when the fix is not a satellite fix, metres. */
  poorFixSigma: number;
}

export const DEFAULT_INTEGRITY: IntegrityOptions = {
  k: 3,
  sigmaVelocity: 0.2,
  window: 60,
  currentTau: 120,
  maxHdop: 4,
  poorFixSigma: 50
};

/** methodQuality values that are a satellite fix (Signal K spec). */
const SATELLITE_FIX = new Set([
  "GNSS Fix",
  "DGNSS fix",
  "Precise GNSS",
  "RTK fixed integer",
  "RTK float"
]);

/** Above this rate of turn the boat is manoeuvring and the current is not learned. */
const STEADY_ROT = 0.01;

interface Dr {
  position: LonLat;
  anchoredAt: number;
  lastAt: number;
  /** σ at the anchor, metres. */
  sigma0: number;
  run: number;
}

/** East, north components of a speed along a true course. */
function vector(course: number, speed: number): [number, number] {
  return [speed * Math.sin(course), speed * Math.cos(course)];
}

export class IntegrityMonitor {
  private dr?: Dr;
  /** Learned current, east and north m/s. */
  private current: [number, number] = [0, 0];

  constructor(private readonly opts: IntegrityOptions = DEFAULT_INTEGRITY) {}

  /** Learned current as [east, north] m/s. */
  currentEstimate(): [number, number] {
    return [...this.current];
  }

  update(nav: IntegrityInputs, now: number): IntegrityResult {
    const gnss = gnssSigma(nav.hdop);
    const reasons: string[] = [];
    let sigma = gnss;
    if (nav.methodQuality !== undefined && !SATELLITE_FIX.has(nav.methodQuality)) {
      reasons.push(`GNSS fix quality "${nav.methodQuality}"`);
      sigma = Math.max(sigma, this.opts.poorFixSigma);
    }
    if (nav.hdop !== undefined && nav.hdop > this.opts.maxHdop) {
      reasons.push(`HDOP ${nav.hdop.toFixed(1)}`);
    }
    const check = this.deadReckon(nav, now, gnss);
    if (check.reason) {
      reasons.push(check.reason);
      sigma = Math.max(sigma, check.divergence as number);
    }
    return {
      sigmaPos: sigma,
      ok: reasons.length === 0,
      reasons,
      divergence: check.divergence,
      unchecked: check.unchecked
    };
  }

  private deadReckon(
    nav: IntegrityInputs,
    now: number,
    gnss: number
  ): { divergence: number | null; reason?: string; unchecked?: string } {
    if (nav.position === undefined || nav.heading === undefined || nav.stw === undefined) {
      this.dr = undefined;
      const missing =
        nav.position === undefined ? "no position" : "no heading or speed through water";
      return { divergence: null, unchecked: `dead reckoning unavailable: ${missing}` };
    }
    const dr = this.dr;
    if (!dr) {
      this.anchor(nav.position, now, gnss);
      return { divergence: 0 };
    }
    const dt = Math.max(0, (now - dr.lastAt) / 1000);
    const [ve, vn] = vector(nav.heading, nav.stw);
    const e = (ve + this.current[0]) * dt;
    const n = (vn + this.current[1]) * dt;
    dr.position = project(dr.position, Math.atan2(e, n), Math.hypot(e, n));
    dr.lastAt = now;
    dr.run += dt;
    const divergence = haversine(dr.position, nav.position);
    const sigmaDr = Math.hypot(dr.sigma0, gnss, this.opts.sigmaVelocity * dr.run);
    if (divergence > this.opts.k * sigmaDr) {
      return {
        divergence,
        reason: `GNSS and dead reckoning differ by ${divergence.toFixed(0)} m`
      };
    }
    this.learnCurrent(nav, dt);
    if (now - dr.anchoredAt >= this.opts.window * 1000) {
      this.anchor(nav.position, now, gnss);
    }
    return { divergence };
  }

  private anchor(position: LonLat, now: number, sigma0: number): void {
    this.dr = { position, anchoredAt: now, lastAt: now, sigma0, run: 0 };
  }

  /** Low-pass of ground velocity minus water velocity while the boat is steady. */
  private learnCurrent(nav: IntegrityInputs, dt: number): void {
    if (nav.cog === undefined || nav.sog === undefined || Math.abs(nav.rot ?? 0) > STEADY_ROT) {
      return;
    }
    const [ge, gn] = vector(nav.cog, nav.sog);
    const [we, wn] = vector(nav.heading as number, nav.stw as number);
    const a = Math.min(1, dt / this.opts.currentTau);
    this.current = [
      this.current[0] + a * (ge - we - this.current[0]),
      this.current[1] + a * (gn - wn - this.current[1])
    ];
  }
}
