import fs from "fs";
import os from "os";
import path from "path";
import type { LivechartConfig } from "../../src/livechart-service";
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
    waterLevel: { h: 0, sigma: 0.05, source: "manual" }
  };
}

const store = () => buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 });

let dir: string;
let file: string;
let log: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-lc-save-"));
  file = path.join(dir, "livechart.json");
  log = path.join(dir, "soundings.ndjson");
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
    cells: unknown[];
    adjustments: unknown[];
    samples?: unknown[];
  };
const logLines = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean);

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
    expect(saved()).toMatchObject({ cells: [expect.anything()], adjustments: [] });
    sound(5.2);
    expect(h.svc.discrepancies()).toHaveLength(1);
    expect(saved().adjustments).toHaveLength(1);
    expect(saved().samples).toBeUndefined();
    // The next cell's posterior changes are written with the 10-minute save.
    const at = h.t.now;
    h.t.now += 1000;
    h.svc.onSounding(raw(9, h.t.now, [22.06, 60.06]));
    h.t.now = at + 9 * 60_000;
    h.svc.flush();
    expect(saved().cells).toHaveLength(1);
    h.t.now = at + 10 * 60_000;
    h.svc.flush();
    expect(saved().cells).toHaveLength(2);
  });

  test("the saves run on the timer, never inside the depth callback", () => {
    const clock = fakeClock(T0);
    let onDepth: (p: string, v: unknown, at: number) => void = () => undefined;
    const monitor = {
      watch: (_paths: string[], fn: typeof onDepth) => (onDepth = fn),
      fresh: () => ({ position: SHOAL, hdop: 0.9, methodQuality: "GNSS Fix" }),
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
    expect(saved().cells).toHaveLength(1);
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
