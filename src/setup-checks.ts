import type { ServerAPI } from "@signalk/server-api";
import type { PluginState } from "./api-wiring";
import type { SchemaHints } from "./config-schema";
import { publicReason } from "./foundation/public-text";
import type { DatumUse } from "./ingest/datum";
import { isLowWaterDatum } from "./model/water-level";
import { selfValue } from "./nav-inputs";

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
}

export type CheckLevel = "ok" | "warn" | "todo";

export interface SetupCheck {
  id: "charts" | "draft" | "waterLevel" | "lookahead";
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

export function setupFacts(app: Pick<ServerAPI, "getSelfPath">, s: PluginState): SetupFacts {
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
    datums: datumFacts(s.monitor?.waterLevelStatus().datums ?? [])
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
    return { id: "charts", level: "todo", text: "Charts: set the ENC cells directory" };
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

export function setupChecks(s: PluginState, facts: SetupFacts): SetupCheck[] {
  return [
    chartsCheck(s, facts),
    draftCheck(s, facts),
    waterLevelCheck(s, facts),
    lookaheadCheck(s)
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
    source: sourceHint(facts)
  };
}
