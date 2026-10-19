/**
 * Optional actual-grounding detector (plan §4.9), off by default. It is the
 * only code path that writes `notifications.grounding` (safety invariant
 * 7). It fires when all hold:
 *
 * - SOG falls by more than 70 % within 5 s, from at least 0.5 m/s;
 * - no gear change in the last 10 s;
 * - measured depth below the surface is within 0.3 m of the draft, or the
 *   look-ahead puts P ≥ 80 % under the vessel;
 * - when an IMU path is configured, its deceleration reached the threshold
 *   in the last 5 s. Without one this condition is not tested.
 *
 * Once fired it holds until SOG stays above 0.5 m/s for 10 s.
 */

export interface GroundingOptions {
  /** Signal K path of longitudinal acceleration, m/s²; empty when there is no IMU. */
  imuPath?: string;
  /** |acceleration| at or above this is a spike, m/s². */
  decelThreshold: number;
}

export const DEFAULT_GROUNDING: GroundingOptions = { decelThreshold: 2 };

const DROP_WINDOW_MS = 5000;
const DROP_RATIO = 0.3;
const MIN_SPEED = 0.5;
const GEAR_QUIET_MS = 10000;
const DEPTH_MARGIN = 0.3;
const RISK_UNDER = 0.8;
const CLEAR_AFTER_MS = 10000;
const FRESH_MS = 5000;

const GEAR_PATH = /^propulsion\.[^.]+\.transmission\.gear$/;

export interface GroundingCheck {
  grounded: boolean;
  /** What fired it, when grounded. */
  reasons: string[];
}

export class GroundingDetector {
  private sog: { v: number; at: number }[] = [];
  private gearAt = -Infinity;
  /** Last gear per transmission: servers repeat unchanged values, which are no gear change. */
  private readonly gears = new Map<string, unknown>();
  private depth?: { v: number; at: number };
  private spikeAt = -Infinity;
  private latched?: string[];
  private movingSince?: number;

  constructor(private readonly opts: GroundingOptions = DEFAULT_GROUNDING) {}

  /** Signal K paths the detector reads beside SOG. */
  paths(): string[] {
    const out = ["environment.depth.belowSurface", "propulsion.*.transmission.gear"];
    return this.opts.imuPath ? [...out, this.opts.imuPath] : out;
  }

  record(path: string, value: unknown, at: number): void {
    const v = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    if (path === "navigation.speedOverGround" && v !== undefined) {
      this.sog = [...this.sog.filter((s) => at - s.at <= DROP_WINDOW_MS), { v, at }];
    } else if (path === "environment.depth.belowSurface" && v !== undefined) {
      this.depth = { v, at };
    } else if (GEAR_PATH.test(path)) {
      if (!this.gears.has(path) || this.gears.get(path) !== value) {
        this.gearAt = at;
      }
      this.gears.set(path, value);
    } else if (
      path === this.opts.imuPath &&
      v !== undefined &&
      Math.abs(v) >= this.opts.decelThreshold
    ) {
      this.spikeAt = at;
    }
  }

  private dropped(now: number): string | undefined {
    const last = this.sog[this.sog.length - 1];
    if (!last || now - last.at > FRESH_MS) {
      return undefined;
    }
    const before = this.sog.filter((s) => last.at - s.at <= DROP_WINDOW_MS && s.v >= MIN_SPEED);
    const peak = Math.max(0, ...before.map((s) => s.v));
    return peak >= MIN_SPEED && last.v <= DROP_RATIO * peak
      ? `SOG fell from ${peak.toFixed(1)} to ${last.v.toFixed(1)} m/s`
      : undefined;
  }

  private shallow(now: number, draft: number, riskUnder: number): string | undefined {
    if (this.depth && now - this.depth.at <= FRESH_MS && this.depth.v <= draft + DEPTH_MARGIN) {
      return `depth ${this.depth.v.toFixed(1)} m against draft ${draft.toFixed(1)} m`;
    }
    return riskUnder >= RISK_UNDER
      ? `P(UKC < 0) ${(riskUnder * 100).toFixed(0)} % under the vessel`
      : undefined;
  }

  check(now: number, draft: number | undefined, riskUnder: number): GroundingCheck {
    if (this.latched) {
      const last = this.sog[this.sog.length - 1];
      const moving = last !== undefined && now - last.at <= FRESH_MS && last.v > MIN_SPEED;
      this.movingSince = moving ? (this.movingSince ?? now) : undefined;
      if (this.movingSince !== undefined && now - this.movingSince >= CLEAR_AFTER_MS) {
        this.latched = undefined;
        this.movingSince = undefined;
        return { grounded: false, reasons: [] };
      }
      return { grounded: true, reasons: this.latched };
    }
    const drop = this.dropped(now);
    const shallow = draft === undefined ? undefined : this.shallow(now, draft, riskUnder);
    const quietGear = now - this.gearAt > GEAR_QUIET_MS;
    const imu = this.opts.imuPath ? now - this.spikeAt <= FRESH_MS : true;
    if (drop && shallow && quietGear && imu) {
      this.latched = [drop, shallow, ...(this.opts.imuPath ? ["deceleration spike"] : [])];
      return { grounded: true, reasons: this.latched };
    }
    return { grounded: false, reasons: [] };
  }
}
