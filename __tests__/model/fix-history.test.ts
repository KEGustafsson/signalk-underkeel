import fs from "fs";
import os from "os";
import path from "path";
import { FixHistoryStore } from "../../src/fix-history-store";
import {
  FixHistory,
  MIN_SAMPLES,
  planningSigma,
  QUANTILE,
  SAMPLE_MS,
  WINDOW_HOURS
} from "../../src/model/fix-history";

/** The demonstrated fix quality a plan's pilotage is checked at (`model/fix-history.ts`). */

const T0 = Date.parse("2026-11-01T00:00:00Z");

/** `n` samples of σ `sigma`, SAMPLE_MS apart from `from`; the time after the last. */
function fill(h: FixHistory, n: number, sigma: number, from: number): number {
  let t = from;
  for (let i = 0; i < n; i++) {
    h.add(sigma, t);
    t += SAMPLE_MS;
  }
  return t;
}

describe("the fix history", () => {
  test("a sample at most every SAMPLE_MS, and none of a σ that is not a number above 0", () => {
    const h = new FixHistory();
    h.add(1, T0);
    h.add(1, T0 + SAMPLE_MS - 1);
    h.add(Number.NaN, T0 + SAMPLE_MS);
    h.add(0, T0 + 2 * SAMPLE_MS);
    expect(h.samples(T0 + 3 * SAMPLE_MS)).toBe(1);
  });

  test("no quantile before MIN_SAMPLES; then the upper edge of the quantile's bin", () => {
    const h = new FixHistory();
    let t = fill(h, MIN_SAMPLES - 1, 1, T0);
    expect(h.quantile(QUANTILE, t)).toBeUndefined();
    // 400 samples at 1.0 m and 30 at 3.0 m: the 95th percentile lies among the 3.0 m ones.
    t = fill(h, 401 - MIN_SAMPLES, 1, t);
    t = fill(h, 30, 3, t);
    expect(h.quantile(QUANTILE, t)).toBe(3.1);
    expect(h.quantile(0.5, t)).toBe(1.1);
  });

  test("a σ wider than the bins counts at its own width, saved and read back", () => {
    const h = new FixHistory();
    let t = fill(h, MIN_SAMPLES, 1, T0);
    t = fill(h, 10, 25, t);
    t = fill(h, 20, 31.24, t);
    expect(h.quantile(QUANTILE, t)).toBe(31.3);
    expect(FixHistory.from(JSON.parse(JSON.stringify(h.toJSON()))).quantile(QUANTILE, t)).toBe(
      31.3
    );
    // Only the bins' own edge without one.
    const edge = new FixHistory();
    t = fill(edge, MIN_SAMPLES, 19.95, T0);
    expect(edge.quantile(QUANTILE, t)).toBe(20);
    expect(edge.toJSON().overflow).toBeUndefined();
  });

  test("samples older than the window drop out", () => {
    const h = new FixHistory();
    const t = fill(h, MIN_SAMPLES, 4, T0);
    expect(h.quantile(QUANTILE, t)).toBe(4.1);
    const later = t + (WINDOW_HOURS + 1) * 3_600_000;
    expect(h.samples(later)).toBe(0);
    expect(h.quantile(QUANTILE, later)).toBeUndefined();
  });

  test("saved and read back the same; anything malformed in a file is left out", () => {
    const h = new FixHistory();
    const t = fill(h, MIN_SAMPLES, 2, T0);
    const back = FixHistory.from(JSON.parse(JSON.stringify(h.toJSON())));
    expect(back.quantile(QUANTILE, t)).toBe(h.quantile(QUANTILE, t));
    const odd = FixHistory.from({
      version: 1,
      hours: { x: { 1: 5 }, 5: { 999: 3, 2: -1, 3: 1.5 } }
    });
    expect(odd.samples(5 * 3_600_000)).toBe(0);
    expect(FixHistory.from({ version: 2, hours: {} }).samples(T0)).toBe(0);
    expect(FixHistory.from(null).samples(T0)).toBe(0);
  });
});

describe("the planning σ", () => {
  test("the configured σ, or the history's when that is wider: own data only adds caution", () => {
    const good = new FixHistory();
    const t = fill(good, MIN_SAMPLES, 0.6, T0);
    expect(planningSigma(good, 1.5, t)).toBe(1.5);
    const poor = new FixHistory();
    fill(poor, MIN_SAMPLES, 2.4, T0);
    expect(planningSigma(poor, 1.5, t)).toBe(2.5);
    expect(planningSigma(undefined, 1.5, t)).toBe(1.5);
    expect(planningSigma(new FixHistory(), 1.5, t)).toBe(1.5);
  });

  test("one fix of the moment does not move it", () => {
    const h = new FixHistory();
    let t = fill(h, 2000, 1.5, T0);
    const before = planningSigma(h, 1, t);
    t = fill(h, 10, 9, t);
    expect(planningSigma(h, 1, t)).toBe(before);
  });
});

describe("the fix history file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-fixes-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("saved when due or forced, and read by the next start", () => {
    const file = path.join(dir, "fix-history.json");
    const store = new FixHistoryStore(file);
    const t = fill(store.history, MIN_SAMPLES, 2, T0);
    store.save(t, true);
    expect(fs.existsSync(file)).toBe(true);
    expect(new FixHistoryStore(file).history.quantile(QUANTILE, t)).toBe(2.1);
    // Nothing new: nothing written.
    fs.rmSync(file);
    store.save(t + 3_600_000, true);
    expect(fs.existsSync(file)).toBe(false);
  });

  test("an unreadable file starts an empty history and says why", () => {
    const file = path.join(dir, "fix-history.json");
    fs.writeFileSync(file, "{not json");
    const store = new FixHistoryStore(file);
    expect(store.error).toMatch(/not readable JSON/);
    expect(store.history.samples(T0)).toBe(0);
  });
});
