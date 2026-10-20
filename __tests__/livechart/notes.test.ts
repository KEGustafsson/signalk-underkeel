import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import { LivechartService } from "../../src/livechart-service";
import type { LivechartConfig } from "../../src/livechart-service";
import { noteValues } from "../../src/livechart/discrepancy";
import type { CellPosterior } from "../../src/livechart/posterior";
import type { RawSounding } from "../../src/livechart/soundings";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { uniform } from "../helpers/arbitraries";
import { basin } from "../helpers/synthetic";

const T0 = 1_800_000_000_000;
const CONFIG: LivechartConfig = {
  source: { path: "environment.depth.belowSurface", transducerDepth: 0, forward: 0, starboard: 0 },
  writeNotes: true,
  csb: { id: "anon", idType: "Other" }
};

function raw(depth: number, at: number): RawSounding {
  return {
    depth,
    at,
    position: [22.05, 60.05],
    positionAt: at,
    hdop: 0.9,
    methodQuality: "GNSS Fix",
    waterLevel: { h: 0, sigma: 0.05, source: "manual" }
  };
}

function service() {
  const t = { now: T0 };
  const notes: { at: number; name: string }[] = [];
  const store = buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 });
  const svc = new LivechartService(store, CONFIG, path.join(dir, "livechart.json"), {
    setNote: (_id, body) => {
      notes.push({ at: t.now, name: String(body.name) });
      return Promise.resolve();
    },
    error: (m) => {
      throw new Error(m);
    },
    now: () => t.now
  });
  /** Two passes 15 minutes apart, `n` readings each, every second, ending at t.now. */
  const passes = (depth: (k: number) => number, n = 3) => {
    for (const start of [t.now, t.now + 15 * 60_000]) {
      for (let k = 0; k < n; k++) {
        t.now = start + k * 1000;
        svc.onSounding(raw(depth(k), t.now));
      }
    }
  };
  const dMin = () => [...store.adjustments.values()][0]?.dMin;
  return { t, notes, svc, passes, dMin };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-notes-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("living-chart notes", () => {
  test("a cell's note is rewritten at most every 5 minutes, with its latest values", () => {
    const h = service();
    // A shoal getting shallower with every reading: each lowers the adjustment by 10 cm.
    h.passes((k) => 5.2 - 0.1 * k, 20);
    expect(h.notes).toHaveLength(1);
    expect(h.svc.discrepancies()).toHaveLength(1);
    h.t.now += 4 * 60_000;
    h.svc.flushNotes();
    expect(h.notes).toHaveLength(1);
    h.t.now += 60_000;
    h.svc.flushNotes();
    expect(h.notes).toHaveLength(2);
    const measured = h.svc.discrepancies()[0]?.measured as number;
    const shown = Number(
      /^Suspected shoal ([\d.]+) m \(charted 8 m\)$/.exec(h.notes[1]?.name ?? "")?.[1]
    );
    expect(shown).toBeLessThanOrEqual(measured);
    expect(shown).toBeGreaterThan(measured - 0.06);
    expect(shown).toBeLessThan(Number(/shoal ([\d.]+) m/.exec(h.notes[0]?.name ?? "")?.[1]));
    // Nothing changed since: nothing more to write.
    h.t.now += 10 * 60_000;
    h.svc.flushNotes();
    expect(h.notes).toHaveLength(2);
  });

  test("a note waiting for its 5 minutes is written when the service stops", () => {
    const h = service();
    h.passes((k) => 5.2 - 0.1 * k, 20);
    expect(h.notes).toHaveLength(1);
    h.svc.stop();
    expect(h.notes).toHaveLength(2);
  });

  test("a lower adjustment that stays inside the same 5 cm does not rewrite the note", () => {
    const h = service();
    h.passes(() => 5.2);
    expect(h.notes).toHaveLength(1);
    // The posterior is at 5.41 m: readings just above 5.40 m lower dMin within its 5 cm step.
    const before = h.dMin() as number;
    h.t.now += 10 * 60_000;
    for (let k = 0; k < 5; k++) {
      h.t.now += 1000;
      h.svc.onSounding(raw(5.405 - 0.0005 * k, h.t.now));
    }
    expect(h.dMin()).toBeLessThan(before);
    expect(h.dMin()).toBeGreaterThan(5.4);
    h.svc.flushNotes();
    expect(h.notes).toHaveLength(1);
  });

  test("a note never shows the cell deeper or its σ smaller than the posterior", () => {
    fc.assert(
      fc.property(uniform(0.3, 200), uniform(0.001, 5), (mean, sigma) => {
        const c: CellPosterior = {
          z: 18,
          x: 1,
          y: 2,
          chartDepth: 250,
          chartSigma: 1,
          cellRef: 0,
          mean,
          sigma,
          samples: 5,
          passes: 2,
          lastAt: T0
        };
        const v = noteValues(c);
        expect(v.measured).toBeLessThanOrEqual(mean);
        expect(mean - v.measured).toBeLessThan(0.05 + 1e-9);
        expect(v.sigma).toBeGreaterThanOrEqual(sigma);
        expect(v.sigma - sigma).toBeLessThan(0.01 + 1e-9);
      })
    );
  });
});
