import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import { tileKey } from "../../src/foundation/geo";
import { CellLog } from "../../src/livechart/cell-log";
import { ndjson } from "../../src/livechart/ndjson";
import type { CellPosterior } from "../../src/livechart/posterior";
import { uniform } from "../helpers/arbitraries";

/**
 * `cells.ndjson` (plan §4.13): appends of the changed cells, the last line per cell winning,
 * and a whole rewrite once the file is twice its live size.
 */

const Z = 18;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-cell-log-"));
  file = path.join(dir, "cells.ndjson");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function cell(x: number, mean: number, samples: number, peakZ?: number): CellPosterior {
  return {
    z: Z,
    x,
    y: 7,
    chartDepth: 8,
    chartSigma: 0.29,
    cellRef: 0,
    mean,
    sigma: 0.1,
    samples,
    passes: 1,
    lastAt: 1_800_000_000_000 + samples,
    ...(peakZ === undefined ? {} : { peakZ })
  };
}

const keyOf = (c: CellPosterior) => tileKey(c.z, c.x, c.y);
const lineCount = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;

/** An operation on the cells: sound cell x, drop it, force a rewrite, or save. */
type Op =
  | { kind: "sound"; x: number; mean: number }
  | { kind: "drop"; x: number }
  | { kind: "rewrite" }
  | { kind: "save" };

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("sound" as const),
      x: fc.integer({ min: 0, max: 9 }),
      mean: uniform(1, 20)
    })
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop" as const), x: fc.nat(9) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rewrite" as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("save" as const) }) }
);

describe("cell log", () => {
  test("after every save the file reads back as the cells, and a rewrite holds one line each", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        fs.rmSync(file, { force: true });
        const log = new CellLog(file, 4);
        const cells = new Map<number, CellPosterior>();
        const changed = new Set<number>();
        let samples = 0;
        for (const o of [...ops, { kind: "save" } as Op]) {
          if (o.kind === "sound") {
            const c = cell(o.x, o.mean, ++samples);
            cells.set(keyOf(c), c);
            changed.add(keyOf(c));
          } else if (o.kind === "drop") {
            // As a prune does: the cell goes, and the file is rewritten without it.
            cells.delete(keyOf(cell(o.x, 0, 0)));
            log.rewrite = true;
          } else if (o.kind === "rewrite") {
            log.rewrite = true;
          } else {
            const wrote = changed.size > 0 || log.rewrite;
            const whole = log.save(cells, changed);
            changed.clear();
            if (!wrote) {
              continue;
            }
            if (whole) {
              expect(lineCount()).toBe(cells.size);
            }
            expect(new CellLog(file).read(Z)?.cells).toEqual(cells);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  test("a file cut at any byte reads each cell as one of its saved values, never another", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), uniform(1, 20)), {
          minLength: 1,
          maxLength: 30
        }),
        uniform(0, 1, 100_000),
        (soundings, cut) => {
          fs.rmSync(file, { force: true });
          const log = new CellLog(file, 1000);
          const cells = new Map<number, CellPosterior>();
          const history = new Map<number, CellPosterior[]>();
          soundings.forEach(([x, mean], i) => {
            const c = cell(x, mean, i + 1);
            cells.set(keyOf(c), c);
            history.set(keyOf(c), [...(history.get(keyOf(c)) ?? []), c]);
            log.save(cells, new Set([keyOf(c)]));
          });
          const content = fs.readFileSync(file);
          fs.writeFileSync(file, content.subarray(0, Math.floor(cut * content.length)));
          const again = new CellLog(file, 1000);
          const read = again.read(Z);
          expect(read?.malformed).toBe(0);
          for (const [key, c] of read?.cells ?? []) {
            expect(history.get(key)).toContainEqual(c);
          }
          const text = fs.readFileSync(file, "utf8");
          const tail = text.slice(text.lastIndexOf("\n") + 1);
          if (tail === "") {
            expect(read?.torn).toBe(false);
          } else {
            // A cut-off last line is skipped, and the file is rewritten whole before any append.
            expect(again.save(read?.cells ?? new Map(), new Set())).toBe(true);
            expect(lineCount()).toBe(read?.cells.size);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test("a cut-off last line is reported as torn", () => {
    const log = new CellLog(file);
    const a = cell(1, 5, 1);
    log.save(new Map([[keyOf(a), a]]), new Set([keyOf(a)]));
    fs.appendFileSync(file, '{"z":18,"x":2');
    const read = new CellLog(file).read(Z);
    expect(read).toMatchObject({ malformed: 0, torn: true });
    expect([...(read?.cells.values() ?? [])]).toEqual([a]);
  });

  test("cells at another zoom are counted, not restored", () => {
    const here = cell(1, 5, 1);
    const coarse = { ...cell(2, 5, 1), z: 16 };
    fs.writeFileSync(file, ndjson([here, coarse, { ...coarse, samples: 2 }, { ...coarse, x: 3 }]));
    const read = new CellLog(file).read(Z);
    expect([...(read?.cells.values() ?? [])]).toEqual([here]);
    expect(read?.otherZoom).toEqual({ zoom: 16, count: 2 });
  });

  test("no cells are written as an empty file, which reads back with no malformed line", () => {
    expect(ndjson([])).toBe("");
    const log = new CellLog(file);
    log.rewrite = true;
    expect(log.save(new Map(), new Set())).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    expect(new CellLog(file).read(Z)).toMatchObject({ malformed: 0, torn: false });
  });
});
