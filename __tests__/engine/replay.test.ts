import { haversine } from "../../src/foundation/geo";
import type { LonLat } from "../../src/foundation/geo";
import type { UnderKeelState } from "../../src/foundation/state";
import { Hysteresis } from "../../src/engine/hysteresis";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import type { VesselModel } from "../../src/model/vessel";
import { ctx } from "../helpers/engine";
import { BANK, fixtureIndex, ROCK } from "../helpers/fixture-index";
import { project } from "../../src/foundation/geo";

/**
 * Replay at 1 Hz over the synthetic chart (plan §7, M1 exit criterion:
 * zero missed alarms on annotated hazards). Each passage is a straight
 * track through an annotated hazard; the engine must reach `alarm` before
 * the bow does, and the timeline must escalate without skipping straight
 * from normal to alarm when there was time to warn. Both hold for the raw
 * engine state and for the published one, which hysteresis raises only
 * after two ticks.
 */

interface Passage {
  name: string;
  start: LonLat;
  cog: number;
  sog: number;
  seconds: number;
  hazard: LonLat;
  vessel: VesselModel;
}

const T0 = 1_800_000_000_000;

interface Tick {
  t: number;
  state: UnderKeelState;
  published: UnderKeelState;
  distance: number;
}

function replay(p: Passage): Tick[] {
  const timeline: Tick[] = [];
  const hysteresis = new Hysteresis(DEFAULT_LOOKAHEAD);
  for (let t = 0; t <= p.seconds; t++) {
    const pos = project(p.start, p.cog, p.sog * t);
    const at = T0 + t * 1000;
    const r = evaluateLookahead(
      {
        position: { value: pos, at },
        cog: { value: p.cog, at },
        sog: { value: p.sog, at },
        heading: { value: p.cog, at }
      },
      ctx(p.vessel),
      fixtureIndex(),
      at
    );
    const published = hysteresis.next(r).state;
    timeline.push({ t, state: r.state, published, distance: haversine(pos, p.hazard) });
    // Every check is on the timeline up to the first published alarm.
    if (published === "alarm") {
      break;
    }
  }
  return timeline;
}

const PASSAGES: Passage[] = [
  {
    name: "eastbound through the swept fairway onto the rock",
    start: [22.006, 60.01],
    cog: Math.PI / 2,
    sog: 3,
    seconds: 300,
    hazard: ROCK,
    vessel: { draft: 3.2, length: 12, beam: 4 }
  },
  {
    // CATZOC C (σP 250 m) burns the 1.8 m sounding 500 m around it, and a
    // C tile counts 500 m beyond the footprint, so the passage starts north
    // of the swept fairway to leave room to warn.
    name: "southbound across the fairway onto the CATZOC C bank",
    start: [22.012, 60.0145],
    cog: Math.PI,
    sog: 2.5,
    seconds: 1000,
    hazard: BANK,
    vessel: { draft: 1.9, length: 10, beam: 3.5 }
  }
];

describe("replay over annotated hazards", () => {
  for (const p of PASSAGES) {
    let replayed: Tick[] | undefined;
    const timeline = (): Tick[] => (replayed ??= replay(p));
    for (const key of ["state", "published"] as const) {
      test(`${p.name} (${key === "state" ? "engine" : "published"} state)`, () => {
        const firstAlarm = timeline().find((e) => e[key] === "alarm");
        expect(firstAlarm).toBeDefined();
        // Alarm while the hull (half-length from its centre) is still short of the hazard.
        expect(firstAlarm?.distance).toBeGreaterThan(p.vessel.length / 2);
        const firstWarn = timeline().find((e) => e[key] === "warn");
        expect(firstWarn).toBeDefined();
        expect(firstWarn?.t).toBeLessThan(firstAlarm?.t ?? -1);
        expect(timeline()[0]?.[key]).not.toBe("alarm");
      });
    }
  }
});
