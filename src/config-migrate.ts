/**
 * Versions of the saved configuration. Each step takes a configuration of
 * one version to the next; a configuration from a newer plugin is left as
 * it is and read for the fields this version knows.
 */

export const CONFIG_VERSION = 2;

type Raw = Record<string, unknown>;

/**
 * Values the version 1 form filled into every saved configuration as
 * defaults. Version 2 leaves these fields empty so the warning style sets
 * them; a saved value equal to its version 1 default was the form's default,
 * not the user's choice, and is dropped.
 */
const V1_FILLED = {
  lookahead: {
    distance: 0.3 * 1852,
    alertRisk: 0.01,
    warnRisk: 0.05,
    alarmRisk: 0.2,
    warnWithin: 120,
    alarmWithin: 60,
    certainWithin: 30
  }
} as const;

function record(v: unknown): Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};
}

function same(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b;
}

/** `group` without the fields equal to their version 1 defaults; `dropped` gets their paths. */
function withoutFilled(group: string, raw: Raw, filled: Raw, dropped: string[]): Raw {
  return Object.fromEntries(
    Object.entries(raw).filter(([key, value]) => {
      const drop = key in filled && same(value, filled[key]);
      if (drop) {
        dropped.push(`${group}.${key}`);
      }
      return !drop;
    })
  );
}

function v1ToV2(c: Raw, dropped: string[]): Raw {
  const out = { ...c };
  // A configuration that already names a warning style was written for version 2.
  if (c.warningStyle === undefined && "lookahead" in c) {
    out.lookahead = withoutFilled("lookahead", record(c.lookahead), V1_FILLED.lookahead, dropped);
  }
  return out;
}

/** Step n takes version n to n + 1. */
const STEPS: Record<number, (c: Raw, dropped: string[]) => Raw> = { 1: v1ToV2 };

export interface Migration {
  config: Raw;
  /** The version the saved configuration had; 1 when it states none. */
  from: number;
  /** Whether `config` differs from what was saved and should be saved. */
  changed: boolean;
  /** Paths of the fields removed as version 1 form defaults. */
  dropped: string[];
}

export function migrateConfig(raw: unknown): Migration {
  const saved = record(raw);
  const stated = saved.configVersion;
  const from = typeof stated === "number" && Number.isInteger(stated) && stated >= 1 ? stated : 1;
  const dropped: string[] = [];
  let config = saved;
  for (let v = from; v < CONFIG_VERSION; v++) {
    const step = STEPS[v];
    config = step ? step(config, dropped) : config;
  }
  if (from >= CONFIG_VERSION) {
    return { config: saved, from, changed: false, dropped };
  }
  return { config: { ...config, configVersion: CONFIG_VERSION }, from, changed: true, dropped };
}
