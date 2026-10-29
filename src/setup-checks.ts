import type { ServerAPI } from "@signalk/server-api";
import os from "os";
import type { PluginState } from "./api-wiring";
import type { SchemaHints } from "./config-schema";
import { usableMemory } from "./foundation/memory";
import { publicReason } from "./foundation/public-text";
import type { DatumUse } from "./ingest/datum";
import { isLowWaterDatum } from "./model/water-level";
import { selfValue } from "./nav-inputs";
import { collectionsHint } from "./shared-enc";

/**
 * What the plugin can see of the boat and the charts, and what is left to
 * set up. The admin form and the setup panel show these beside the fields;
 * nothing here changes a setting.
 */

export interface DatumFact {
  /** S-57 VERDAT code; undefined when the cells state none. */
  verdat?: number;
  cells: number;
  lowWater: boolean;
  /** Mapped to an FMI series, so FMI can supply the level for it. */
  fmi: boolean;
}

/** The machine the server runs on, for the hardware advice. */
export interface HostFacts {
  /** RAM this process may use (a container's limit when it sets one), bytes. */
  memory: number;
  /** RAM free for new allocations now, bytes. */
  available: number;
  cpus: number;
}

export function hostFacts(): HostFacts {
  const memory = usableMemory();
  return { memory, available: Math.min(os.freemem(), memory), cpus: os.availableParallelism() };
}

export interface SetupFacts {
  /** `design.*` from Signal K, metres. */
  signalk: { draft?: number; length?: number; beam?: number };
  /** `environment.depth.*` paths that have a value. */
  depthPaths: ("belowTransducer" | "belowSurface")[];
  /** Whether `environment.tide.heightNow` has a value. */
  tide: boolean;
  /** Cells in the loaded index; 0 without one. */
  cells: number;
  datums: DatumFact[];
  host: HostFacts;
}

export type CheckLevel = "ok" | "warn" | "todo";

export interface SetupCheck {
  id: "charts" | "draft" | "waterLevel" | "lookahead" | "hardware";
  level: CheckLevel;
  text: string;
}

function number(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function datumFacts(uses: readonly DatumUse[]): DatumFact[] {
  return uses.map((u) => ({
    verdat: u.verdat,
    cells: u.cells.length,
    lowWater: u.verdat === undefined || isLowWaterDatum(u.verdat),
    fmi: u.known
  }));
}

export function setupFacts(
  app: Pick<ServerAPI, "getSelfPath">,
  s: PluginState,
  host: HostFacts = hostFacts()
): SetupFacts {
  const value = (path: string) => selfValue(app, path);
  const draft = value("design.draft") as { maximum?: unknown } | undefined;
  const length = value("design.length") as { overall?: unknown } | undefined;
  const depthPaths = (["belowTransducer", "belowSurface"] as const).filter(
    (p) => typeof value(`environment.depth.${p}`) === "number"
  );
  return {
    signalk: {
      draft: number(draft?.maximum),
      length: number(length?.overall),
      beam: number(value("design.beam"))
    },
    depthPaths,
    tide: typeof value("environment.tide.heightNow") === "number",
    cells: s.load?.index?.catalogue.cells.length ?? 0,
    datums: datumFacts(s.monitor?.waterLevelStatus().datums ?? []),
    host
  };
}

/**
 * The source to suggest for the charts' datums, as the no-source reason
 * names it: fmi when a datum that is not low water is mapped to an FMI
 * series, else signalk-tide or manual; none when every datum is low water.
 */
export function suggestedSource(datums: readonly DatumFact[]): "fmi" | "signalk-tide" | undefined {
  const high = datums.filter((d) => !d.lowWater);
  if (high.length === 0) {
    return undefined;
  }
  return high.some((d) => d.fmi) ? "fmi" : "signalk-tide";
}

function chartsCheck(s: PluginState, facts: SetupFacts): SetupCheck {
  if (facts.cells > 0) {
    return { id: "charts", level: "ok", text: `Charts: ${facts.cells} cells indexed` };
  }
  if (!s.config?.cellsDir && !s.config?.wfs) {
    return {
      id: "charts",
      level: "todo",
      text: "Charts: set the ENC cells directory or ENC from Charts Provider"
    };
  }
  const reason = publicReason(s.load?.reason) ?? "no chart index loaded";
  return { id: "charts", level: "warn", text: `Charts: ${reason}` };
}

function draftCheck(s: PluginState, facts: SetupFacts): SetupCheck {
  const own = s.config?.vessel.draft;
  if (own !== undefined) {
    return { id: "draft", level: "ok", text: `Draft ${own} m` };
  }
  if (facts.signalk.draft !== undefined) {
    return {
      id: "draft",
      level: "ok",
      text: `Draft ${facts.signalk.draft} m from design.draft.maximum`
    };
  }
  return { id: "draft", level: "todo", text: "Draft: not set here or in design.draft.maximum" };
}

function waterLevelCheck(s: PluginState, facts: SetupFacts): SetupCheck {
  const source = s.config?.waterLevel.source ?? "none";
  const degraded = s.monitor?.waterLevelStatus().applied.degraded;
  if (degraded !== undefined) {
    return { id: "waterLevel", level: "warn", text: `Water level: ${publicReason(degraded)}` };
  }
  const suggested = suggestedSource(facts.datums);
  if (source === "none" && suggested) {
    return { id: "waterLevel", level: "todo", text: `Water level: choose ${suggested}` };
  }
  return { id: "waterLevel", level: "ok", text: `Water level: ${source}` };
}

function lookaheadCheck(s: PluginState): SetupCheck {
  const last = s.monitor?.last;
  if (!last) {
    return { id: "lookahead", level: "warn", text: `Look-ahead: ${s.stopped.reason}` };
  }
  const reason = last.reason ? `, ${publicReason(last.reason)}` : "";
  const level: CheckLevel = last.state === "off" || last.state === "unknown" ? "warn" : "ok";
  return { id: "lookahead", level, text: `Look-ahead: ${last.state}${reason}` };
}

const GIB = 2 ** 30;
/** At or below this the machine is a 1 GB class one: a Raspberry Pi 3 or a Cerbo GX. */
export const SMALL_MEMORY = 1.5 * GIB;
/** At or above this a whole small chart set can be indexed at once. */
export const LARGE_MEMORY = 4 * GIB;
/** Less free than this and a chart index build may not fit. */
export const LOW_AVAILABLE = 256 * 2 ** 20;

const gb = (bytes: number): string => (bytes / GIB).toFixed(1);

/** Advice on the index settings for a 1 GB class machine; empty elsewhere. */
function smallMachineAdvice(s: PluginState, memory: number): string[] {
  if (memory > SMALL_MEMORY) {
    return [];
  }
  const advice: string[] = [];
  // With the Traficom WFS on, its own radius sets the box.
  if (s.config?.boxRadiusKm === 0 && !s.config.wfs) {
    advice.push(
      "Index box 0 indexes every cell, which may not fit in this memory: set Index box around the vessel to 10 km unless the chart set is small"
    );
  }
  if ((s.config?.leafZoom ?? 0) >= 20) {
    advice.push("consider Index leaf zoom 19, which needs fewer tiles");
  }
  return advice;
}

/**
 * The machine's RAM and CPUs, with advice on the index settings. It never changes a
 * setting: the user decides, and a smaller box or a coarser leaf zoom only warns more.
 */
function hardwareCheck(s: PluginState, facts: SetupFacts): SetupCheck {
  const { memory, available, cpus } = facts.host;
  const head = `Hardware: ${cpus} CPU${cpus === 1 ? "" : "s"}, ${gb(memory)} GB RAM, ${gb(available)} GB free`;
  const advice = smallMachineAdvice(s, memory);
  if (available < LOW_AVAILABLE) {
    const mb = Math.round(available / 2 ** 20);
    advice.push(
      `only ${mb} MB free: a chart index build may run out of memory; stop plugins you do not use`
    );
  }
  if (advice.length > 0) {
    return { id: "hardware", level: "warn", text: `${head}. ${advice.join("; ")}.` };
  }
  const box = s.config?.boxRadiusKm ?? 0;
  if (memory >= LARGE_MEMORY && box > 0 && !s.config?.wfs) {
    const tip =
      "With a small chart set, Index box 0 indexes it once and avoids rebuilds as the vessel moves.";
    return { id: "hardware", level: "ok", text: `${head}. ${tip}` };
  }
  return { id: "hardware", level: "ok", text: head };
}

export function setupChecks(s: PluginState, facts: SetupFacts): SetupCheck[] {
  return [
    chartsCheck(s, facts),
    draftCheck(s, facts),
    waterLevelCheck(s, facts),
    lookaheadCheck(s),
    hardwareCheck(s, facts)
  ];
}

const MARK: Record<CheckLevel, string> = { ok: "✓", warn: "!", todo: "✗" };

/** A sentence naming the datums that are not low water and the source to choose. */
function sourceHint(facts: SetupFacts): string | undefined {
  const suggested = suggestedSource(facts.datums);
  if (!suggested) {
    return undefined;
  }
  const high = facts.datums
    .filter((d) => !d.lowWater)
    .map((d) => `VERDAT ${String(d.verdat)} in ${d.cells} cells`)
    .join(", ");
  return `Your charts are not on low water (${high}): choose ${suggested === "fmi" ? "fmi in Finnish waters" : "signalk-tide or manual"}.`;
}

/** The admin form's notes, from the same facts and checks as the setup panel's. */
export function schemaHints(app: Pick<ServerAPI, "getSelfPath">, s: PluginState): SchemaHints {
  const facts = setupFacts(app, s);
  return {
    checks: setupChecks(s, facts).map((c) => `${MARK[c.level]} ${c.text}`),
    signalkDraft: facts.signalk.draft,
    source: sourceHint(facts),
    encCollections: collectionsHint()
  };
}
