import { buildEnvelope, classOf, EnvelopeTracker } from "../../src/engine/envelope";
import type { LookaheadResult } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import { notificationFor } from "../../src/engine/notify";
import { ctx } from "../helpers/engine";
import { fixtureIndex, M_PER_DEG_LON, ROCK } from "../helpers/fixture-index";

const NOW = 1_800_000_000_000;
const TH = DEFAULT_LOOKAHEAD.thresholds;

function at(lon: number, lat: number, sog = 3): LookaheadResult {
  return evaluateLookahead(
    {
      position: { value: [lon, lat], at: NOW },
      cog: { value: Math.PI / 2, at: NOW },
      sog: { value: sog, at: NOW }
    },
    ctx({ draft: 3.2, length: 12, beam: 4 }),
    fixtureIndex(),
    NOW
  );
}

describe("envelope", () => {
  test("track, segments and worst point, within the 15 kB budget", () => {
    // 1 m/s gives a 556 s horizon: the cone runs 300 m to the rock and on past it.
    const r = at(ROCK[0] - 300 / M_PER_DEG_LON, ROCK[1], 1);
    const env = buildEnvelope(r, TH);
    const kinds = env.features.map((f) => f.properties.kind);
    expect(kinds[0]).toBe("track");
    const segments = env.features.filter((f) => f.properties.kind === "segment");
    const classes = segments.map((f) => f.properties.class);
    expect(classes[0]).toBe("clear");
    expect(classes).toContain("danger");
    expect(classes[classes.length - 1]).toBe("clear");
    classes.slice(1).forEach((c, i) => expect(c).not.toBe(classes[i]));
    expect(segments[0]?.properties.from).toBe(0);
    expect(segments[segments.length - 1]?.properties.to).toBe(r.horizon);
    expect(kinds[kinds.length - 1]).toBe("worst");
    expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThan(15_000);
    const worst = env.features.find((f) => f.properties.kind === "worst");
    expect(worst?.properties.explanation).toMatchObject({
      hazard: { class: "UWTROC", depth: 3.5 },
      draft: 3.2
    });
  });

  test("footprint classes", () => {
    expect(classOf({ risk: 0, uncovered: true, charted: null }, TH)).toBe("unverified");
    expect(classOf({ risk: 0, uncovered: true, charted: 5 }, TH)).toBe("unverified");
    expect(classOf({ risk: 0.5, uncovered: true, charted: 5 }, TH)).toBe("danger");
    expect(classOf({ risk: 0.05, uncovered: false, charted: 5 }, TH)).toBe("danger");
    expect(classOf({ risk: 0.02, uncovered: false, charted: 5 }, TH)).toBe("caution");
    expect(classOf({ risk: 0, uncovered: false, charted: 5 }, TH)).toBe("clear");
  });

  test("land and no-coverage values are null, never Infinity", () => {
    const env = buildEnvelope(at(22.0275, 60.0145, 0), TH);
    const text = JSON.stringify(env);
    expect(text).not.toMatch(/Infinity/);
    const worst = env.features.find((f) => f.properties.kind === "worst");
    expect((worst?.properties.explanation as { charted: unknown }).charted).toBeNull();
  });

  test("rev bumps only when the envelope changes", () => {
    const tracker = new EnvelopeTracker();
    expect(tracker.update(buildEnvelope(at(22.005, 60.01), TH))).toBe(true);
    expect(tracker.rev).toBe(1);
    expect(tracker.update(buildEnvelope(at(22.005, 60.01), TH))).toBe(false);
    expect(tracker.rev).toBe(1);
    expect(tracker.update(buildEnvelope(at(22.006, 60.01), TH))).toBe(true);
    expect(tracker.rev).toBe(2);
  });
});

describe("notification", () => {
  const base: LookaheadResult = {
    state: "normal",
    reason: "",
    clearance: 2,
    clearanceSigma: 0.3,
    risk: 0,
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
    const r = at(ROCK[0] - 120 / M_PER_DEG_LON, ROCK[1]);
    expect(r.state).toBe("alarm");
    const n = notificationFor(r);
    expect(n.state).toBe("alarm");
    expect(n.method).toEqual(["visual", "sound"]);
    expect(n.message).toMatch(/charted 3\.5 m UWTROC FI5-ROCK .* P = \d+ %$/);
    expect(n.data).toMatchObject({
      engineState: "alarm",
      clearance: r.clearance,
      risk: r.risk,
      timeToShoal: r.timeToShoal
    });
    expect(n.data.explanation).toEqual(r.worst?.explanation);
    expect(notificationFor({ ...base, state: "warn", reason: "x" }).state).toBe("warn");
    expect(notificationFor({ ...base, state: "alert", reason: "x" }).method).toEqual(["visual"]);
  });
});
