import type { EngineStatus } from "./foundation/state";
import type { IndexLoad } from "./index-loader";
import type { Monitor } from "./monitor";
import type { LivechartService } from "./livechart-service";
import type { WfsService } from "./wfs-service";

/** Body of `GET /status`: engine state, index provenance and look-ahead summary; `?summary` without the per-cell lists. */

function indexSection(load: IndexLoad | undefined, summary: boolean): Record<string, unknown> {
  const index = load?.index;
  return {
    dir: load?.indexDir,
    loaded: index !== undefined,
    built: load?.built ?? false,
    reason: load?.reason,
    nodes: index?.pyramid.count ?? 0,
    hazards: index?.hazards.size ?? 0,
    ...(summary ? {} : { cells: index?.catalogue.cells ?? [] })
  };
}

function monitorSection(m: Monitor, summary: boolean): Record<string, unknown> {
  const { datums, ...waterLevel } = m.waterLevelStatus();
  return {
    engine: { state: m.last.state, reason: m.last.reason, since: new Date(m.since).toISOString() },
    lookahead: {
      clearance: m.last.clearance,
      timeToShoal: m.last.timeToShoal,
      horizon: m.last.horizon,
      envelopeRev: m.envelope.rev
    },
    vessel: m.vesselNotes,
    waterLevel: summary ? waterLevel : { ...waterLevel, datums },
    integrity: m.integrityResult ?? null
  };
}

export function statusReport(s: {
  load: IndexLoad | undefined;
  monitor: Monitor | undefined;
  zoneErrors?: string[];
  livechart?: LivechartService;
  wfs?: WfsService;
  stopped: EngineStatus;
  now: number;
  /**
   * Leave out the lists that grow with the cells (`index.cells`,
   * `waterLevel.datums`), for a client that polls the status often.
   */
  summary?: boolean;
}): unknown {
  const summary = s.summary ?? false;
  return {
    ...(s.monitor ? monitorSection(s.monitor, summary) : { engine: s.stopped, vessel: [] }),
    index: indexSection(s.load, summary),
    livechart: s.livechart?.status() ?? null,
    wfs: s.wfs?.downloads ? s.wfs.status() : null,
    chartBox: s.wfs ? boxSection(s.wfs) : null,
    mooringZones: {
      loaded: s.monitor?.zones.map((z) => z.name) ?? [],
      errors: s.zoneErrors ?? []
    },
    checkedAt: new Date(s.now).toISOString()
  };
}

/** The box the index is built in around the vessel, as the box service keeps it. */
function boxSection(box: WfsService): unknown {
  const { busy, lastError } = box.status();
  return { box: box.current ?? null, busy, lastError: lastError ?? null };
}
