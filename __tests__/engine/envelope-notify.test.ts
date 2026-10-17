import { buildEnvelope, classOf, EnvelopeTracker } from "../../src/engine/envelope";
import type { LookaheadResult } from "../../src/engine/lookahead";
import { evaluateLookahead } from "../../src/engine/lookahead";
import { notificationFor } from "../../src/engine/notify";
import { fixtureIndex, M_PER_DEG_LON, ROCK } from "../helpers/fixture-index";

const NOW = 1_800_000_000_000;

function at(lon: number, lat: number, sog = 3): LookaheadResult {
  return evaluateLookahead(
    {
      position: { value: [lon, lat], at: NOW },
      cog: { value: Math.PI / 2, at: NOW },
      sog: { value: sog, at: NOW }
    },
    { draft: 3.2, length: 12, beam: 4 },
    fixtureIndex(),
    NOW
  );
}

describe("envelope", () => {
  test("track, segments and worst point, within the 15 kB budget", () => {
    // 1 m/s gives a 556 s horizon: the cone runs 300 m to the rock and on past it.
    const r = at(ROCK[0] - 300 / M_PER_DEG_LON, ROCK[1], 1);
    const env = buildEnvelope(r);
    const kinds = env.features.map((f) => f.properties.kind);
    expect(kinds[0]).toBe("track");
    const segments = env.features.filter((f) => f.properties.kind === "segment");
    expect(segments.map((f) => f.properties.class)).toEqual(["clear", "shoal", "clear"]);
    expect(segments[0]?.properties.from).toBe(0);
    expect(segments[2]?.properties.to).toBe(r.horizon);
    expect(kinds[kinds.length - 1]).toBe("worst");
    expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThan(15_000);
    const worst = env.features.find((f) => f.properties.kind === "worst");
    expect(worst?.properties.hazard).toMatchObject({ class: "UWTROC", depth: 3.5 });
  });

  test("footprint classes", () => {
    expect(classOf({ ukc: null, uncovered: true })).toBe("unverified");
    expect(classOf({ ukc: 1, uncovered: true })).toBe("unverified");
    expect(classOf({ ukc: -0.1, uncovered: true })).toBe("shoal");
    expect(classOf({ ukc: -0.1, uncovered: false })).toBe("shoal");
    expect(classOf({ ukc: 0, uncovered: false })).toBe("clear");
  });

  test("land and no-coverage values are null, never Infinity", () => {
    const env = buildEnvelope(at(22.0275, 60.0145, 0));
    const text = JSON.stringify(env);
    expect(text).not.toMatch(/Infinity/);
    const worst = env.features.find((f) => f.properties.kind === "worst");
    expect(worst?.properties.charted).toBeNull();
  });

  test("rev bumps only when the envelope changes", () => {
    const tracker = new EnvelopeTracker();
    const a = buildEnvelope(at(22.005, 60.01));
    expect(tracker.update(a)).toBe(true);
    expect(tracker.rev).toBe(1);
    expect(tracker.update(buildEnvelope(at(22.005, 60.01)))).toBe(false);
    expect(tracker.rev).toBe(1);
    expect(tracker.update(buildEnvelope(at(22.006, 60.01)))).toBe(true);
    expect(tracker.rev).toBe(2);
  });
});

describe("notification", () => {
  const base: LookaheadResult = {
    state: "normal",
    reason: "",
    clearance: 2,
    timeToShoal: null,
    horizon: 60,
    footprints: []
  };

  test("normal clears with no method", () => {
    expect(notificationFor(base)).toMatchObject({
      state: "normal",
      method: [],
      message: "Under-keel clearance normal"
    });
    expect(notificationFor({ ...base, reason: "low speed" }).message).toBe(
      "Under-keel clearance normal (low speed)"
    );
  });

  test("degraded monitoring is an alert, never silent", () => {
    expect(notificationFor({ ...base, state: "unknown", reason: "position stale" })).toMatchObject({
      state: "alert",
      method: ["visual"],
      message: "UKC monitoring degraded: position stale"
    });
    expect(notificationFor({ ...base, state: "off", reason: "no chart index" }).message).toBe(
      "UKC monitoring off: no chart index"
    );
  });

  test("warn and alarm sound; the message explains the worst point", () => {
    const r = at(ROCK[0] - 75 / M_PER_DEG_LON, ROCK[1]);
    expect(r.state).toBe("alarm");
    const n = notificationFor(r);
    expect(n.state).toBe("alarm");
    expect(n.method).toEqual(["visual", "sound"]);
    expect(n.message).toMatch(/charted 3\.5 m \(UWTROC FI5-ROCK\)/);
    expect(n.data).toEqual({
      engineState: "alarm",
      clearance: r.clearance,
      timeToShoal: r.timeToShoal
    });
    expect(notificationFor({ ...base, state: "warn", reason: "x" }).state).toBe("warn");
    expect(notificationFor({ ...base, state: "alert", reason: "x" }).method).toEqual(["visual"]);
  });
});
