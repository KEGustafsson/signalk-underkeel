import type { ServerAPI } from "@signalk/server-api";
import type { NavState, Sample } from "./engine/lookahead";
import type { LonLat } from "./foundation/geo";

/** Reading the subscribed navigation paths into the look-ahead's NavState. */

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asPosition(v: unknown): LonLat | undefined {
  const p = v as { latitude?: unknown; longitude?: unknown } | null;
  const lat = asNumber(p?.latitude);
  const lon = asNumber(p?.longitude);
  return lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lon, lat]
    : undefined;
}

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

export const INPUT_PATHS = Object.keys(INPUTS);

/** Signal K timestamps from the future are clock errors; trust receipt time then. */
const FUTURE_TOLERANCE_MS = 5000;

export function sampleTime(timestamp: string | undefined, now: number): number {
  const t = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(t) && t <= now + FUTURE_TOLERANCE_MS ? t : now;
}

/** `getSelfPath` returns the full node; the reading is under `.value`. */
export function selfValue(app: Pick<ServerAPI, "getSelfPath">, path: string): unknown {
  const node = app.getSelfPath(path) as { value?: unknown } | undefined;
  return node && typeof node === "object" && "value" in node ? node.value : node;
}

/**
 * The latest navigation inputs and the `$source` each came from. An invalid
 * value (a receiver that lost its fix sends null) clears an input only when it
 * comes from the source that set it: with two receivers, one without a fix
 * must not wipe the other's position every second.
 */
export class NavInputs {
  readonly nav: NavState = {};
  private readonly sources = new Map<keyof NavState, string | undefined>();

  /** Returns false when `path` is not a navigation input. */
  record(path: string, value: unknown, at: number, source: string | undefined): boolean {
    const input = INPUTS[path];
    if (!input) {
      return false;
    }
    const v = input.read(value);
    if (v !== undefined) {
      (this.nav as Record<string, Sample<unknown>>)[input.key] = { value: v, at };
      this.sources.set(input.key, source);
      return true;
    }
    const holder = this.sources.get(input.key);
    if (holder === undefined || holder === source) {
      delete this.nav[input.key];
      this.sources.delete(input.key);
    }
    return true;
  }
}
