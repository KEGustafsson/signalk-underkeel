import fs from "fs";
import os from "os";
import path from "path";
import type { LivechartConfig } from "../../src/livechart-service";
import type { CellPosterior } from "../../src/livechart/posterior";
import { LivechartService, MAX_SAMPLES, startLivechart } from "../../src/livechart-service";
import type { RawSounding } from "../../src/livechart/soundings";
import { parseConfig } from "../../src/config";
import type { Monitor } from "../../src/monitor";
import type { ChartIndex } from "../../src/spatial/chart-index";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { fakeClock } from "../helpers/plugin-harness";
import { basin } from "../helpers/synthetic";

const T0 = 1_800_000_000_000;
const CONFIG: LivechartConfig = {
  source: { path: "environment.depth.belowSurface", transducerDepth: 0, forward: 0, starboard: 0 },
  writeNotes: false,
  csb: { id: "anon", idType: "Other" }
};
const SHOAL: [number, number] = [22.05, 60.05];

function raw(depth: number, at: number, position = SHOAL): RawSounding {
  return {
    depth,
    at,
    position,
    positionAt: at,
    hdop: 0.9,
    methodQuality: "GNSS Fix",
    // Under way: the CSB log keeps every sounding (csb-thin.test.ts covers the thinning).
    sog: 3,
    waterLevel: { h: 0, sigma: 0.05, source: "manual" }
  };
}

const store = () => buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 });

let dir: string;
let file: string;
let log: string;
let cellLog: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-lc-save-"));
  file = path.join(dir, "livechart.json");
  log = path.join(dir, "soundings.ndjson");
  cellLog = path.join(dir, "cells.ndjson");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function service(errors: string[] = []) {
  const t = { now: T0 };
  const svc = new LivechartService(store(), CONFIG, file, {
    setNote: () => Promise.resolve(),
    error: (m) => errors.push(m),
    now: () => t.now
  });
  return { t, svc, errors };
}

const saved = () =>
  JSON.parse(fs.readFileSync(file, "utf8")) as {
    cells?: unknown[];
    adjustments: unknown[];
    samples?: unknown[];
  };
const logLines = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
const cellLines = (): CellPosterior[] =>
  fs.existsSync(cellLog)
    ? fs
        .readFileSync(cellLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as CellPosterior)
    : [];
const cellKeys = () => new Set(cellLines().map((c) => `${c.x}/${c.y}`));

describe("living-chart save schedule", () => {
  test("a new adjustment is on disk within 10 s; other changes wait for the 10-minute save", () => {
    const h = service();
    const sound = (depth: number) => {
      h.t.now += 1000;
      h.svc.onSounding(raw(depth, h.t.now));
      h.svc.flush();
    };
    // Agrees with the 8 m chart: posterior evidence only.
    sound(8);
    expect(fs.existsSync(file)).toBe(false);
    h.t.now += 60_000;
    h.svc.flush();
    expect(logLines()).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
    // Two passes over a 5 m shoal; the 10-minute save falls between them.
    for (let k = 0; k < 3; k++) {
      sound(5.2);
    }
    h.t.now += 15 * 60_000;
    h.svc.flush();
    expect(cellLines()).toHaveLength(1);
    expect(saved()).toEqual({ version: 1, zoom: 18, adjustments: [] });
    sound(5.2);
    expect(h.svc.discrepancies()).toHaveLength(1);
    expect(saved().adjustments).toHaveLength(1);
    expect(saved().cells).toBeUndefined();
    expect(saved().samples).toBeUndefined();
    // The shoal cell's line is appended with the adjustment.
    expect(cellLines()).toHaveLength(2);
    // The next cell's posterior changes are written with the 10-minute save.
    const at = h.t.now;
    h.t.now += 1000;
    h.svc.onSounding(raw(9, h.t.now, [22.06, 60.06]));
    h.t.now = at + 9 * 60_000;
    h.svc.flush();
    expect(cellKeys().size).toBe(1);
    h.t.now = at + 10 * 60_000;
    h.svc.flush();
    expect(cellKeys().size).toBe(2);
    expect(cellLines()).toHaveLength(3);
  });

  test("the saves run on the timer, never inside the depth callback", () => {
    const clock = fakeClock(T0);
    let onDepth: (p: string, v: unknown, at: number) => void = () => undefined;
    const monitor = {
      watch: (_paths: string[], fn: typeof onDepth) => (onDepth = fn),
      fresh: () => ({ position: SHOAL, hdop: 0.9, methodQuality: "GNSS Fix", sog: 3 }),
      nav: { position: { at: T0 } },
      waterLevel: () => ({ h: 0, sigma: 0.05, source: "manual" })
    } as unknown as Monitor;
    const lc = startLivechart(
      {
        getDataDirPath: () => dir,
        resourcesApi: { setResource: () => Promise.resolve() } as never,
        error: (m: string) => {
          throw new Error(m);
        }
      },
      clock,
      parseConfig({ livechart: { enabled: true } }),
      { pyramid: store() } as unknown as ChartIndex,
      monitor
    );
    const write = jest.spyOn(fs, "writeFileSync");
    try {
      for (let s = 0; s < 120; s++) {
        monitor.nav.position = { value: SHOAL, at: T0 + s * 1000 } as never;
        onDepth("environment.depth.belowSurface", 6, T0 + s * 1000);
      }
      expect(write).not.toHaveBeenCalled();
      clock.advance(120_000);
      expect(write).toHaveBeenCalled();
    } finally {
      write.mockRestore();
      lc?.stop();
    }
    expect(logLines()).toHaveLength(120);
    expect(cellKeys().size).toBe(1);
  });

  test("a state file that could not be set aside does not bring the log save forward", () => {
    fs.writeFileSync(file, "not json");
    const rename = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("read-only");
    });
    let h: ReturnType<typeof service>;
    try {
      h = service();
    } finally {
      rename.mockRestore();
    }
    expect(h.errors.join()).toMatch(/not moved aside/);
    // Shoal soundings over two passes make adjustments, which would save the state within 10 s.
    let lines = 0;
    for (let s = 0; s < 1800; s += 10) {
      h.t.now = T0 + s * 1000;
      h.svc.onSounding(raw(5, h.t.now));
      h.svc.flush();
      const now = fs.existsSync(log) ? logLines().length : 0;
      if (now !== lines) {
        lines = now;
        expect(s % 60).toBe(0);
      }
    }
    expect(lines).toBeGreaterThan(0);
    expect(fs.readFileSync(file, "utf8")).toBe("not json");
  });

  test("a version-1 file with samples still loads, and its samples move to soundings.ndjson", () => {
    const sample = (at: number) => ({
      at,
      belowSurface: 5,
      depth: 4.8,
      sigma: 0.2,
      position: [22, 60]
    });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, zoom: 18, cells: [], adjustments: [], samples: [sample(T0)] })
    );
    const first = service();
    expect((first.svc.csb() as { features: unknown[] }).features).toHaveLength(1);
    first.svc.onSounding(raw(6, T0 + 1000));
    first.svc.save();
    expect(saved().samples).toBeUndefined();
    expect(logLines()).toHaveLength(2);
    const again = service();
    expect((again.svc.csb() as { features: unknown[] }).features).toHaveLength(2);
    expect(again.errors).toEqual([]);
  });

  test("an older version's soundings stay in the state file while the log cannot hold them", () => {
    const sample = (at: number) => ({
      at,
      belowSurface: 5,
      depth: 4.8,
      sigma: 0.2,
      position: [22, 60]
    });
    const legacy = [sample(T0), sample(T0 + 1000)];
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, zoom: 18, cells: [], adjustments: [], samples: legacy })
    );
    // A malformed log that cannot be moved aside is never written.
    fs.writeFileSync(log, "not json\n");
    const rename = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("read-only");
    });
    let h: ReturnType<typeof service>;
    try {
      h = service();
    } finally {
      rename.mockRestore();
    }
    h.svc.onSounding(raw(6, T0 + 2000));
    h.svc.save();
    expect(fs.readFileSync(log, "utf8")).toBe("not json\n");
    expect(saved().samples).toEqual(legacy);
    // Once the log can be set aside, the next start still has them and moves them into it.
    const again = service();
    expect((again.svc.csb() as { features: unknown[] }).features).toHaveLength(2);
    again.svc.save();
    expect(logLines()).toHaveLength(2);
    expect(saved().samples).toBeUndefined();
  });

  test("an older version's soundings stay in the state file until a failed log save succeeds", () => {
    const sample = (at: number) => ({
      at,
      belowSurface: 5,
      depth: 4.8,
      sigma: 0.2,
      position: [22, 60]
    });
    const legacy = [sample(T0), sample(T0 + 1000)];
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, zoom: 18, cells: [], adjustments: [], samples: legacy })
    );
    const h = service();
    const open = fs.openSync;
    const full = jest.spyOn(fs, "openSync").mockImplementation((p, ...rest) => {
      if (String(p).startsWith(`${log}.tmp`)) {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return open(p, ...rest);
    });
    try {
      h.svc.save();
    } finally {
      full.mockRestore();
    }
    expect(h.errors.join()).toMatch(/soundings\.ndjson not saved: no space left/);
    expect(fs.existsSync(log)).toBe(false);
    expect(saved().samples).toEqual(legacy);
    h.svc.onSounding(raw(6, T0 + 2000));
    h.svc.save();
    expect(logLines()).toHaveLength(3);
    expect(saved().samples).toBeUndefined();
  });

  test("a sample log twice the kept length is compacted to the newest samples", () => {
    const h = service();
    for (let k = 0; k < 2 * MAX_SAMPLES; k++) {
      h.svc.onSounding(raw(6, T0 + k * 100));
      if (k === MAX_SAMPLES - 1) {
        h.svc.save();
      }
    }
    h.svc.save();
    expect(logLines()).toHaveLength(2 * MAX_SAMPLES);
    h.svc.onSounding(raw(6, T0 + 2 * MAX_SAMPLES * 100));
    h.svc.save();
    const lines = logLines();
    expect(lines).toHaveLength(MAX_SAMPLES);
    expect((JSON.parse(lines[0] as string) as { at: number }).at).toBe(
      T0 + (MAX_SAMPLES + 1) * 100
    );
  });

  test("a truncated last line is skipped and reported, and the log is rewritten whole", () => {
    const first = service();
    first.svc.onSounding(raw(6, T0));
    first.svc.onSounding(raw(6, T0 + 1000));
    first.svc.save();
    // A power cut in the middle of an append.
    fs.appendFileSync(log, '{"at":18000000020');
    const again = service();
    expect(again.errors).toEqual([`${log}: skipped a truncated last line`]);
    expect((again.svc.csb() as { features: unknown[] }).features).toHaveLength(2);
    again.svc.onSounding(raw(6, T0 + 2000));
    again.svc.save();
    expect(logLines().map((l) => (JSON.parse(l) as { at: number }).at)).toEqual([
      T0,
      T0 + 1000,
      T0 + 2000
    ]);
  });

  test("a log with malformed lines is moved aside and rewritten from the lines that read", () => {
    fs.writeFileSync(
      log,
      [
        "not json",
        JSON.stringify({ at: T0, belowSurface: 5, depth: 4.8, sigma: 0.2, position: [22, 60] }),
        JSON.stringify({ at: "late" })
      ].join("\n") + "\n"
    );
    const h = service();
    expect(h.errors).toEqual([
      expect.stringMatching(
        /soundings\.ndjson had 2 malformed lines, skipped; moved to .*\.bad-\d+$/
      )
    ]);
    h.svc.save();
    expect(logLines()).toHaveLength(1);
  });

  test("a log rewritten with no soundings reads back whole at the next start", () => {
    fs.writeFileSync(log, "not json\n");
    const h = service();
    expect(h.errors).toHaveLength(1);
    h.svc.save();
    expect(fs.readFileSync(log, "utf8")).toBe("");
    expect(service().errors).toEqual([]);
  });
});

/** Two cells sounded and saved as this version saves them; returns their posteriors. */
function twoCells(): Map<number, CellPosterior> {
  const h = service();
  h.svc.onSounding(raw(8.2, T0));
  h.svc.onSounding(raw(7.5, T0 + 1000, [22.06, 60.06]));
  h.svc.save();
  return new Map(posteriorsOf(h.svc).cells);
}

/** Rewrites the files in the version-1 layout: the cells in livechart.json, no cells.ndjson. */
function toVersion1(): void {
  fs.writeFileSync(file, JSON.stringify({ ...saved(), cells: cellLines() }));
  fs.rmSync(cellLog);
}

const posteriorsOf = (svc: LivechartService) =>
  (svc as unknown as { posteriors: { cells: Map<number, CellPosterior> } }).posteriors;

function expectSameCells(a: Map<number, CellPosterior>, b: Map<number, CellPosterior>): void {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [key, c] of a) {
    expect(b.get(key)).toMatchObject({ samples: c.samples, lastAt: c.lastAt });
    expect(b.get(key)?.mean).toBeCloseTo(c.mean, 9);
    expect(b.get(key)?.sigma).toBeCloseTo(c.sigma, 9);
  }
}

describe("cells.ndjson", () => {
  test("at anchor each 10-minute save appends one line, and livechart.json is not rewritten", () => {
    const h = service();
    const rename = jest.spyOn(fs, "renameSync");
    try {
      // Six hours in one cell, a reading and a check every 10 s, agreeing with the chart.
      for (let s = 10; s <= 6 * 3600; s += 10) {
        h.t.now = T0 + s * 1000;
        h.svc.onSounding(raw(8.2, h.t.now));
        h.svc.flush();
      }
      expect(cellLines()).toHaveLength(36);
      // Written once, at the first save, to record the zoom; no adjustment changed after.
      expect(rename.mock.calls.filter(([, to]) => to === file)).toHaveLength(1);
      expect(rename.mock.calls.filter(([, to]) => to === cellLog)).toHaveLength(0);
    } finally {
      rename.mockRestore();
    }
  });

  test("settling restored cells without adjustments does not rewrite livechart.json", async () => {
    twoCells();
    const h = service();
    await h.svc.whenSettled();
    const rename = jest.spyOn(fs, "renameSync");
    try {
      h.svc.save();
      expect(rename).not.toHaveBeenCalled();
    } finally {
      rename.mockRestore();
    }
  });

  test("a version-1 livechart.json holding the cells loads them, and they move at the first save", async () => {
    const before = twoCells();
    toVersion1();
    const h = service();
    await h.svc.whenSettled();
    expectSameCells(before, posteriorsOf(h.svc).cells);
    const rename = jest.spyOn(fs, "renameSync");
    try {
      h.svc.save();
      expect(rename.mock.calls.map(([, to]) => to)).toEqual([cellLog, file]);
    } finally {
      rename.mockRestore();
    }
    expect(cellLines()).toHaveLength(2);
    expect(saved().cells).toBeUndefined();
    expect(h.errors).toEqual([]);
    const again = service();
    await again.svc.whenSettled();
    expectSameCells(before, posteriorsOf(again.svc).cells);
  });

  test("cells stay in livechart.json until cells.ndjson can be written whole", async () => {
    twoCells();
    toVersion1();
    const h = service();
    await h.svc.whenSettled();
    // A directory where the temporary file goes makes the rewrite throw.
    fs.mkdirSync(`${cellLog}.tmp-${process.pid}`);
    h.svc.save();
    expect(h.errors).toEqual([expect.stringMatching(/cells\.ndjson not saved/)]);
    expect(saved().cells).toHaveLength(2);
    expect(fs.existsSync(cellLog)).toBe(false);
    // The failed write removed what was in its way: the next save moves the cells.
    h.svc.save();
    expect(cellLines()).toHaveLength(2);
    expect(saved().cells).toBeUndefined();
  });

  test("a cell in both files loads with the copy with more samples, livechart.json's on a tie", async () => {
    twoCells();
    const [a, b] = cellLines() as [CellPosterior, CellPosterior];
    // The log holds a newer a and an older b; livechart.json the other way round, b tied.
    fs.writeFileSync(
      cellLog,
      [
        { ...a, samples: 3, lastAt: 1 },
        { ...b, lastAt: 2 }
      ]
        .map((c) => JSON.stringify(c) + "\n")
        .join("")
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...saved(),
        cells: [
          { ...a, samples: 2, lastAt: 3 },
          { ...b, lastAt: 4 }
        ]
      })
    );
    const h = service();
    await h.svc.whenSettled();
    const lastAt = [...posteriorsOf(h.svc).cells.values()].map((c) => c.lastAt).sort();
    expect(lastAt).toEqual([1, 4]);
  });

  test("a malformed or unreadable cells.ndjson is moved aside and rewritten from what read", () => {
    twoCells();
    fs.appendFileSync(cellLog, "not json\n");
    const h = service();
    expect(h.errors).toEqual([
      expect.stringMatching(/cells\.ndjson had 1 malformed lines, skipped; moved to .*\.bad-\d+$/)
    ]);
    h.svc.save();
    expect(cellLines()).toHaveLength(2);

    fs.rmSync(cellLog);
    fs.mkdirSync(cellLog);
    const unreadable = service();
    expect(unreadable.errors).toEqual([
      expect.stringMatching(/cells\.ndjson is not readable, starting empty: .*; moved to /)
    ]);
    unreadable.svc.onSounding(raw(8.2, T0 + 5000));
    unreadable.svc.save();
    expect(cellLines()).toHaveLength(1);
  });

  test("a cells.ndjson that cannot be moved aside is never written; its cells go in livechart.json", () => {
    twoCells();
    fs.appendFileSync(cellLog, "not json\n");
    const content = fs.readFileSync(cellLog, "utf8");
    const rename = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("read-only");
    });
    let h: ReturnType<typeof service>;
    try {
      h = service();
    } finally {
      rename.mockRestore();
    }
    expect(h.errors.join()).toMatch(/cells\.ndjson had 1 malformed lines.*not moved aside/);
    h.svc.onSounding(raw(8.2, T0 + 5000, [22.07, 60.07]));
    h.svc.save();
    expect(fs.readFileSync(cellLog, "utf8")).toBe(content);
    expect(saved().cells).toHaveLength(3);
  });
});
