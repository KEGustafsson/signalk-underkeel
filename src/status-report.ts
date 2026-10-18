import type { EngineStatus } from "./foundation/state";
import type { IndexLoad } from "./index-loader";
import type { Monitor } from "./monitor";

/** Body of `GET /status`: engine state, index provenance and look-ahead summary. */

function indexSection(load: IndexLoad | undefined): Record<string, unknown> {
  const index = load?.index;
  return {
    dir: load?.indexDir,
    loaded: index !== undefined,
    built: load?.built ?? false,
    reason: load?.reason,
    nodes: index?.pyramid.count ?? 0,
    hazards: index?.hazards.size ?? 0,
    cells: index?.catalogue.cells ?? []
  };
}

function monitorSection(m: Monitor): Record<string, unknown> {
  return {
    engine: { state: m.last.state, reason: m.last.reason, since: new Date(m.since).toISOString() },
    lookahead: {
      clearance: m.last.clearance,
      timeToShoal: m.last.timeToShoal,
      horizon: m.last.horizon,
      envelopeRev: m.envelope.rev
    },
    vessel: m.vesselNotes
  };
}

export function statusReport(s: {
  load: IndexLoad | undefined;
  monitor: Monitor | undefined;
  stopped: EngineStatus;
  now: number;
}): unknown {
  return {
    ...(s.monitor ? monitorSection(s.monitor) : { engine: s.stopped, vessel: [] }),
    index: indexSection(s.load),
    checkedAt: new Date(s.now).toISOString()
  };
}
