import type { EnvelopeFeature } from "../../src/engine/envelope";
import {
  buildEnvelope,
  classOf,
  ENVELOPE_DEADBAND,
  EnvelopeTracker
} from "../../src/engine/envelope";
import type { LookaheadResult } from "../../src/engine/lookahead";
import { DEFAULT_LOOKAHEAD, evaluateLookahead } from "../../src/engine/lookahead";
import { notificationFor, notificationKey } from "../../src/engine/notify";
import { ChangeNotifier } from "../../src/notifications";
import { FLAGS } from "../../src/spatial/node-store";
import { ctx } from "../helpers/engine";
import { fixtureIndex, M_PER_DEG_LON, ROCK } from "../helpers/fixture-index";

const NOW = 1_800_000_000_000;

function inside(p: readonly number[], ring: number[][]): boolean {
  let odd = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i] as [number, number];
    const [bx, by] = ring[j] as [number, number];
    if (ay > (p[1] as number) !== by > (p[1] as number)) {
      if ((p[0] as number) < ((bx - ax) * ((p[1] as number) - ay)) / (by - ay) + ax) {
        odd = !odd;
      }
    }
  }
  return odd;
}

/** Distance in degrees from p to the ring's edges, longitude scaled at 60° N. */
function edgeDistance(p: readonly number[], ring: number[][]): number {
  const k = Math.cos((60 * Math.PI) / 180);
  let d = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1] as [number, number];
    const [bx, by] = ring[i] as [number, number];
    const dx = (bx - ax) * k;
    const dy = by - ay;
    const px = ((p[0] as number) - ax) * k;
    const py = (p[1] as number) - ay;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(px - t * dx, py - t * dy));
  }
  return d;
}
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

  test("the cone is drawn on both sides of a straight track and covers every footprint", () => {
    // Open water, heading east at 3 m/s with no turn: the fan is symmetric about the track.
    const r = at(22.003, 60.0125, 3);
    const lat0 = r.footprints[0]?.center[1] as number;
    const env = buildEnvelope(r, TH);
    const outline = env.features
      .filter((f) => f.properties.kind === "segment")
      .flatMap((f) => (f.geometry.coordinates as number[][][])[0] as number[][]);
    const north = Math.max(...outline.map((p) => (p[1] as number) - lat0));
    const south = Math.max(...outline.map((p) => lat0 - (p[1] as number)));
    expect(north).toBeGreaterThan(0);
    expect(Math.abs(north - south) / north).toBeLessThan(0.05);
    // Every footprint's widest point across the track lies on the drawn outline (1 m rounding).
    const tol = 2e-5;
    for (const f of r.footprints) {
      const top = Math.max(...f.ring.map((p) => p[1]));
      const bottom = Math.min(...f.ring.map((p) => p[1]));
      expect(north + lat0).toBeGreaterThanOrEqual(top - tol);
      expect(lat0 - south).toBeLessThanOrEqual(bottom + tol);
    }
  });

  test("a 400-footprint horizon keeps the budget and its outline holds every footprint", () => {
    const opts = { ...DEFAULT_LOOKAHEAD, distance: 5 * 1852, minHorizon: 600 };
    for (const rot of [0, 0.004]) {
      const r = evaluateLookahead(
        {
          position: { value: [22.003, 60.0125], at: NOW },
          cog: { value: Math.PI / 2, at: NOW },
          sog: { value: 0.3, at: NOW },
          rot: { value: rot, at: NOW }
        },
        ctx({ draft: 3.2, length: 12, beam: 4 }),
        fixtureIndex(),
        NOW,
        opts
      );
      expect(r.footprints.length).toBe(400);
      const env = buildEnvelope(r, TH);
      expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThan(15_000);
      const rings = env.features
        .filter((f) => f.properties.kind === "segment")
        .map((f) => (f.geometry.coordinates as number[][][])[0] as number[][]);
      // Inside a drawn segment or near its edge: the outline joins each footprint's port and
      // starboard extremes, so in a turn a hull corner can sit up to 2 m outside it.
      const near = (p: readonly number[]) =>
        rings.some((ring) => inside(p, ring) || edgeDistance(p, ring) < 2.5e-5);
      for (const f of r.footprints) {
        f.ring.forEach((p) => expect(near(p)).toBe(true));
      }
    }
  });

  test("footprint classes", () => {
    expect(classOf({ risk: 0, uncovered: true, charted: null }, TH)).toBe("unverified");
    expect(classOf({ risk: 0, uncovered: true, charted: 5 }, TH)).toBe("unverified");
    expect(classOf({ risk: 0.5, uncovered: true, charted: 5 }, TH)).toBe("danger");
    expect(classOf({ risk: 0.05, uncovered: false, charted: 5 }, TH)).toBe("danger");
    expect(classOf({ risk: 0.02, uncovered: false, charted: 5 }, TH)).toBe("caution");
    expect(classOf({ risk: 0, uncovered: false, charted: 5 }, TH)).toBe("clear");
  });

  test("advisory, unassessed or fallback-level water is never drawn clear", () => {
    const calm = at(22.003, 60.01, 1);
    const classes = (r: LookaheadResult) =>
      buildEnvelope(r, TH)
        .features.filter((f) => f.properties.kind === "segment")
        .map((f) => f.properties.class);
    expect(classes(calm)).toContain("clear");
    for (const flag of [FLAGS.NOT_FOR_NAVIGATION, FLAGS.UNASSESSED]) {
      const flagged = calm.footprints.map((f) => ({ ...f, flags: f.flags | flag }));
      expect(classes({ ...calm, footprints: flagged })).not.toContain("clear");
    }
    const fallback = { h: 0, sigma: 0.3, source: "chart-datum", degraded: "water level stale" };
    expect(classes({ ...calm, waterLevel: fallback })).not.toContain("clear");
    expect(classOf({ risk: 0, uncovered: false, charted: 5 }, TH, true)).toBe("unverified");
    expect(classOf({ risk: 0.1, uncovered: false, charted: 5 }, TH, true)).toBe("danger");
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
    const start = tracker.rev;
    expect(tracker.update(buildEnvelope(at(22.005, 60.01), TH))).toBe(true);
    expect(tracker.rev).toBe(start + 1);
    expect(tracker.update(buildEnvelope(at(22.005, 60.01), TH))).toBe(false);
    expect(tracker.rev).toBe(start + 1);
    expect(tracker.update(buildEnvelope(at(22.006, 60.01), TH))).toBe(true);
    expect(tracker.rev).toBe(start + 2);
  });

  test("at rest, GPS noise within the deadband keeps the rev; a move or a class change bumps it", () => {
    const still = (east: number) => buildEnvelope(at(22.005 + east / M_PER_DEG_LON, 60.01, 0), TH);
    const tracker = new EnvelopeTracker();
    tracker.update(still(0), ENVELOPE_DEADBAND);
    const rev = tracker.rev;
    for (const east of [1.5, -2, 3, 0.5]) {
      expect(tracker.update(still(east), ENVELOPE_DEADBAND)).toBe(false);
    }
    expect(tracker.rev).toBe(rev);
    // Measured from the published envelope, so small steps do not add up unseen.
    expect(tracker.update(still(6), ENVELOPE_DEADBAND)).toBe(true);
    expect(tracker.rev).toBe(rev + 1);
    const recoloured = still(6.5);
    const segment = recoloured.features.find((f) => f.properties.kind === "segment");
    (segment as EnvelopeFeature).properties.class = "danger";
    expect(tracker.update(recoloured, ENVELOPE_DEADBAND)).toBe(true);
    // Under way there is no deadband.
    expect(tracker.update(still(7), 0)).toBe(true);
  });

  test("a new tracker starts above every rev issued before it", () => {
    const old = new EnvelopeTracker();
    old.update(buildEnvelope(at(22.005, 60.01), TH));
    const next = new EnvelopeTracker();
    expect(next.rev).toBeGreaterThan(old.rev);
    expect(next.rev).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(Number.isSafeInteger(next.rev)).toBe(true);
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
    footprints: [],
    escapeHeading: null
  };

  test("the repeat key follows state, reason and hazard, not the countdown", () => {
    const warn = (reason: string, lnam?: string): LookaheadResult => ({
      ...base,
      state: "warn",
      reason,
      worst: lnam
        ? {
            t: 30,
            position: [22, 60],
            explanation: { hazard: { class: "UWTROC", lnam, depth: 1 } } as never
          }
        : undefined
    });
    const key = (r: LookaheadResult) => notificationKey(r);
    expect(key(warn("shoal ahead in 117 s", "A"))).toBe(key(warn("shoal ahead in 114 s", "A")));
    expect(key(warn("shoal ahead in 117 s", "A"))).not.toBe(key(warn("shoal ahead in 117 s", "B")));
    expect(key(warn("shoal ahead in 117 s"))).not.toBe(
      key(warn("no chart coverage ahead in 117 s"))
    );
    expect(key(warn("shoal ahead in 117 s"))).not.toBe(
      key({ ...warn("shoal ahead in 117 s"), state: "alarm" })
    );
  });

  test("a repeated key waits for the refresh; a new key goes out at once", () => {
    const sent: unknown[] = [];
    const notifier = new ChangeNotifier({ handleMessage: (_id, d) => sent.push(d) }, "p");
    const n = (state: string, message: string) => ({ state, method: [], message });
    const at = (key: string, now: number) => ({ key, refreshMs: 30_000, now });
    notifier.send("x", n("warn", "in 117 s"), at("warn", 0));
    notifier.send("x", n("warn", "in 114 s"), at("warn", 3_000));
    notifier.send("x", n("warn", "in 90 s"), at("warn", 29_000));
    expect(sent).toHaveLength(1);
    notifier.send("x", n("warn", "in 87 s"), at("warn", 30_000));
    notifier.send("x", n("warn", "in 86 s"), at("warn", 31_000));
    expect(sent).toHaveLength(2);
    notifier.send("x", n("alarm", "in 85 s"), at("alarm", 32_000));
    expect(sent).toHaveLength(3);
  });

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
