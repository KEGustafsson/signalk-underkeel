import fs from "fs";
import path from "path";
import type { ServerAPI } from "@signalk/server-api";
import type { ApiReply } from "./api/routes";
import type { PluginState } from "./api-wiring";
import type { Migration } from "./config-migrate";
import { CONFIG_VERSION } from "./config-migrate";
import { WARNING_PRESETS } from "./config-presets";
import { SCHEMA } from "./config-schema";
import { DEFAULT_DYNAMICS } from "./model/vessel";
import { setupChecks, setupFacts, suggestedSource } from "./setup-checks";

/**
 * The setup panel's view of the configuration (`GET /settings`) and its
 * save (`POST /settings`). A save is a patch on the saved configuration,
 * checked against the schema field by field, then handed to the server's
 * restart callback, which writes it and restarts the plugin. Both routes are
 * admin-only: the configuration names directories on the server.
 */

type Raw = Record<string, unknown>;

/** Where the version 1 configuration is kept when it is first migrated. */
export const V1_BACKUP = "config-v1.json";

function isObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Saves a migrated configuration, after keeping a version 1 one beside the plugin data. */
export function persistMigration(
  app: Pick<ServerAPI, "getDataDirPath" | "savePluginOptions" | "error">,
  saved: unknown,
  m: Migration
): void {
  if (!m.changed) {
    return;
  }
  const backup = path.join(app.getDataDirPath(), V1_BACKUP);
  try {
    if (m.from === 1 && !fs.existsSync(backup)) {
      fs.writeFileSync(backup, JSON.stringify(saved ?? {}, null, 2));
    }
  } catch (err) {
    app.error(`configuration backup not written: ${(err as Error).message}`);
    return;
  }
  if (typeof app.savePluginOptions !== "function") {
    return;
  }
  app.savePluginOptions(m.config, (err) => {
    if (err) {
      app.error(`migrated configuration not saved: ${err.message}`);
    }
  });
}

export function settingsReply(app: Pick<ServerAPI, "getSelfPath">, s: PluginState): ApiReply {
  if (!s.options) {
    return { status: 503, body: { errors: ["plugin not started"] } };
  }
  const facts = setupFacts(app, s);
  return {
    status: 200,
    body: {
      configVersion: CONFIG_VERSION,
      values: s.options,
      facts,
      suggestedSource: suggestedSource(facts.datums) ?? null,
      checks: setupChecks(s, facts),
      presets: { warningStyles: WARNING_PRESETS },
      defaults: {
        blockCoefficient: DEFAULT_DYNAMICS.blockCoefficient,
        waveFactor: DEFAULT_DYNAMICS.waveFactor
      },
      schema: SCHEMA
    }
  };
}

/** The values a field's schema allows: its enum or the consts of its oneOf. */
function allowed(schema: Raw): unknown[] | undefined {
  if (Array.isArray(schema.enum)) {
    return schema.enum as unknown[];
  }
  return Array.isArray(schema.oneOf)
    ? (schema.oneOf as Raw[]).map((o) => o.const).filter((c) => c !== undefined)
    : undefined;
}

function isType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

/** A number outside the schema's minimum or maximum, as an error. */
function rangeError(where: string, value: unknown, schema: Raw): string | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    return `${where} must be at least ${schema.minimum}`;
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return `${where} must be at most ${schema.maximum}`;
  }
  return undefined;
}

/** Errors of one value against its field's schema: type, choice, range and each array item. */
function valueErrors(where: string, value: unknown, schema: Raw): string[] {
  if (schema.type === "object") {
    return isObject(value)
      ? patchErrors(value, schema, `${where}.`)
      : [`${where} must be an object`];
  }
  if (!isType(value, schema.type)) {
    return [`${where} must be a ${String(schema.type)}`];
  }
  const values = allowed(schema);
  if (values && !values.includes(value)) {
    return [`${where} must be one of ${values.join(", ")}`];
  }
  const range = rangeError(where, value, schema);
  if (range) {
    return [range];
  }
  const items = schema.items;
  return Array.isArray(value) && isObject(items)
    ? value.flatMap((item, i) => valueErrors(`${where}[${i}]`, item, items))
    : [];
}

/** Errors of a patch against `schema`'s fields; null deletes a field and is always allowed. */
export function patchErrors(patch: Raw, schema: Raw, prefix = ""): string[] {
  const fields = isObject(schema.properties) ? schema.properties : {};
  return Object.entries(patch).flatMap(([key, value]) => {
    const where = `${prefix}${key}`;
    const field = fields[key];
    if (!isObject(field)) {
      return [`${where} is not a setting`];
    }
    return value === null ? [] : valueErrors(where, value, field);
  });
}

/** `patch` applied to `base`: objects merged field by field, null removing a field. */
export function applyPatch(base: Raw, patch: Raw): Raw {
  const out: Raw = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isObject(value)) {
      out[key] = applyPatch(isObject(out[key]) ? out[key] : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Schema fields plus showExpert, which only the admin form reads. */
const PATCHABLE = {
  ...SCHEMA,
  properties: { ...SCHEMA.properties, showExpert: { type: "boolean" } }
};

/**
 * Checks and applies a patch, answers 202 and then hands the new
 * configuration to the server's restart callback, which saves it and
 * restarts the plugin. The reply comes first, so it claims no save; the
 * panel reads the settings back to show what was saved. `later` runs the
 * restart after the reply is sent, where a throw would be uncaught, so it is
 * logged instead.
 */
export function saveSettings(
  body: unknown,
  s: PluginState,
  log: (message: string) => void,
  later: (f: () => void) => void = setImmediate
): ApiReply {
  const restart = s.restart;
  if (!s.options || !restart) {
    return { status: 503, body: { errors: ["plugin not started"] } };
  }
  if (!isObject(body)) {
    return { status: 400, body: { errors: ["body must be a JSON object"] } };
  }
  const errors = patchErrors(body, PATCHABLE);
  if (errors.length > 0) {
    return { status: 400, body: { errors } };
  }
  const config = { ...applyPatch(s.options, body), configVersion: CONFIG_VERSION };
  later(() => {
    try {
      restart(config);
    } catch (err) {
      log(`settings not saved, plugin not restarted: ${(err as Error).message}`);
    }
  });
  return { status: 202, body: { restarting: true } };
}
