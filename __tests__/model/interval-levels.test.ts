import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import type { DatumUse } from "../../src/ingest/datum";
import { IntervalLevels } from "../../src/model/interval-levels";
import type { LevelSample, WaterLevelProvider } from "../../src/model/water-level";
import { highestWaterLevel, lowestWaterLevel, STALE_AFTER_MS } from "../../src/model/water-level";

/**
 * The level over an interval, found once (`interval-levels.ts`): the same answer as sampling
 * the source again, for any order of questions, a new forecast and data gone stale.
 */

const NOW = Date.parse("2026-11-24T07:00:00Z");
const HOUR = 3600 * 1000;
const CENTRE: LonLat = [22.3, 60.3];
/** 0.5° of latitude is 55 km: beyond a reach of 30 km. */
const FAR: LonLat = [22.3, 60.8];
const NEAR: LonLat = [22.35, 60.31];

/** A source like the FMI's: a level that swings with time, within 30 km of CENTRE. */
class Swinging implements WaterLevelProvider {
  readonly id = "swinging";
  readonly reference = "chart";
  fetchedAt = NOW;
  shift = 0;
  fetches = 0;
  asked = 0;

  levelAt(position: LonLat | undefined, t: number): LevelSample | undefined {
    this.asked++;
    if (position && Math.abs(position[1] - CENTRE[1]) > 0.27) {
      return undefined;
    }
    // No value past 48 h, as a forecast ends.
    if (t > this.fetchedAt + 48 * HOUR) {
      return undefined;
    }
    return { h: this.shift + 0.4 * Math.sin(t / (3.1 * HOUR)), sigma: 0.05, source: "swinging" };
  }

  health() {
    return { ok: true, lastUpdate: this.fetchedAt };
  }

  reach() {
    return { centre: CENTRE, metres: 30_000 };
  }

  revision(): number {
    return this.fetches;
  }

  /** A new forecast, `shift` metres higher, taken at `at`. */
  refetch(shift: number, at: number): void {
    this.shift = shift;
    this.fetchedAt = at;
    this.fetches++;
  }
}

const USES: DatumUse[] = [];
const place = fc.constantFrom<LonLat | undefined>(undefined, CENTRE, NEAR, FAR);
const hours = fc.integer({ min: 0, max: 60 });

describe("the level over an interval, kept", () => {
  test("is the level sampled again, lowest and highest, in any order of questions", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            position: place,
            from: hours,
            length: fc.integer({ min: 0, max: 12 }),
            high: fc.boolean(),
            // Now and then a new forecast arrives, or the clock runs on, past stale too.
            refetch: fc.option(fc.integer({ min: -3, max: 3 }), { freq: 6, nil: undefined }),
            later: fc.constantFrom(0, 0, 0, 5 * 60_000, STALE_AFTER_MS + 60_000)
          }),
          { minLength: 1, maxLength: 40 }
        ),
        (questions) => {
          const p = new Swinging();
          const kept = new IntervalLevels();
          let now = NOW;
          const wrong: unknown[] = [];
          for (const q of questions) {
            now += q.later;
            if (q.refetch !== undefined) {
              p.refetch(q.refetch / 10, now);
            }
            const [start, end] = [NOW + q.from * HOUR, NOW + (q.from + q.length) * HOUR];
            const got = (q.high ? kept.highest : kept.lowest)(p, USES, q.position, start, end, now);
            const want = (q.high ? highestWaterLevel : lowestWaterLevel)(
              p,
              USES,
              q.position,
              start,
              end,
              now
            );
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              wrong.push({ q, got, want });
            }
          }
          expect(wrong).toEqual([]);
        }
      ),
      { numRuns: 300 }
    );
  });

  test("asks the source once for an interval, wherever within its reach", () => {
    const p = new Swinging();
    const kept = new IntervalLevels();
    const first = kept.lowest(p, USES, CENTRE, NOW, NOW + 6 * HOUR, NOW);
    const asked = p.asked;
    expect(asked).toBeGreaterThan(30);
    expect(kept.lowest(p, USES, NEAR, NOW, NOW + 6 * HOUR, NOW + 1000)).toEqual(first);
    expect(kept.lowest(p, USES, CENTRE, NOW, NOW + 6 * HOUR, NOW + 2000)).toEqual(first);
    expect(p.asked).toBe(asked);
    // Beyond the reach it is another level, a fallback, found once too.
    const beyond = kept.lowest(p, USES, FAR, NOW, NOW + 6 * HOUR, NOW);
    expect(beyond.degraded).toMatch(/more than 30 km/);
    const then = p.asked;
    expect(kept.lowest(p, USES, FAR, NOW, NOW + 6 * HOUR, NOW)).toEqual(beyond);
    expect(p.asked).toBe(then);
  });

  test("a level given is the caller's own: changing it changes none given later", () => {
    const p = new Swinging();
    const kept = new IntervalLevels();
    const first = kept.lowest(p, USES, CENTRE, NOW, NOW + HOUR, NOW);
    const h = first.h;
    first.h = 99;
    first.note = "mine";
    expect(kept.lowest(p, USES, CENTRE, NOW, NOW + HOUR, NOW)).toMatchObject({ h });
    expect(kept.lowest(p, USES, CENTRE, NOW, NOW + HOUR, NOW).note).toBeUndefined();
  });

  test("a new forecast is read at once", () => {
    const p = new Swinging();
    const kept = new IntervalLevels();
    const before = kept.lowest(p, USES, CENTRE, NOW, NOW + 6 * HOUR, NOW);
    p.refetch(0.3, NOW + 60_000);
    const after = kept.lowest(p, USES, CENTRE, NOW, NOW + 6 * HOUR, NOW + 60_000);
    expect(after.h).toBeCloseTo(before.h + 0.3, 9);
  });

  test("data gone stale is a fallback, never the level kept while it was fresh", () => {
    const p = new Swinging();
    const kept = new IntervalLevels();
    const fresh = kept.lowest(p, USES, CENTRE, NOW, NOW + HOUR, NOW);
    expect(fresh.degraded).toBeUndefined();
    const stale = kept.lowest(p, USES, CENTRE, NOW, NOW + HOUR, NOW + STALE_AFTER_MS + 1);
    expect(stale.degraded).toMatch(/min old/);
    expect(stale.source).toBe("fallback");
  });

  test("a source with no revision is asked every time", () => {
    const p = new Swinging();
    const plain: WaterLevelProvider = {
      id: p.id,
      reference: p.reference,
      levelAt: (position, t) => p.levelAt(position, t),
      health: () => p.health()
    };
    const kept = new IntervalLevels();
    kept.lowest(plain, USES, CENTRE, NOW, NOW + HOUR, NOW);
    const asked = p.asked;
    kept.lowest(plain, USES, CENTRE, NOW, NOW + HOUR, NOW);
    expect(p.asked).toBe(2 * asked);
  });
});
