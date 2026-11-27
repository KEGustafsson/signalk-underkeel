import fs from "fs";
import os from "os";
import path from "path";
import type { OdcTiles } from "../src/charts-provider-tiles";
import type { Bbox } from "../src/ingest/wfs";
import { OdcBox } from "../src/odc-box";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-odc-box-unit-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const BOX: Bbox = [-5, 47.8, -4.9, 47.9];
const KEY = "odc-a 9/248/178";
const signal = new AbortController().signal;

function tiles(stage: OdcTiles["stage"]): OdcTiles {
  return { key: () => KEY, stage };
}

describe("the Open Data Charts box cell", () => {
  test("after failed reads the charts wait from the handover, longer each time, until one succeeds", async () => {
    let clock = 0;
    let fail = true;
    const errors: string[] = [];
    const box = new OdcBox(
      TMP,
      {
        catzoc: 4,
        tiles: tiles((_bbox, file) => {
          if (fail) {
            return Promise.reject(new Error("tile store busy"));
          }
          fs.writeFileSync(file, "tiles");
          return Promise.resolve(1);
        })
      },
      (m) => errors.push(m),
      () => clock
    );
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const staged = await box.stage(BOX, clock, signal);
      expect(staged.failed).toBe("tile store busy");
      // The build without the charts takes 12 minutes before it is handed over.
      clock += 720_000;
      const record = box.built(staged, undefined);
      expect(record).toEqual({});
      const handedOver = clock;
      while (!box.changed(BOX, record, clock)) {
        clock += 60_000;
      }
      waits.push(clock - handedOver);
    }
    expect(waits).toEqual([300_000, 600_000, 1_200_000]);
    expect(errors).toHaveLength(3);
    expect(box.note(clock)).toBe("Open Data Charts not read: tile store busy");

    fail = false;
    const staged = await box.stage(BOX, clock, signal);
    const record = box.built(staged, { tiles: 1, features: 3, skipped: 0 });
    await OdcBox.whileStaged(staged, () => Promise.resolve());
    expect(record).toEqual({ odc: KEY, odcTiles: 1, odcCatzoc: 4 });
    expect(box.note(clock)).toBeUndefined();
    fail = true;
    const again = await box.stage(BOX, clock, signal);
    box.built(again, undefined);
    expect(box.note(clock)).toBe(
      "Open Data Charts not read: tile store busy (read again in 5 min)"
    );
  });

  test("tiles left out as unreadable are told, and a cell with none readable is a failed read", () => {
    const box = new OdcBox(TMP, { catzoc: 4, tiles: tiles(() => Promise.resolve(0)) });
    const stage = { key: KEY, count: 2, catzoc: 4 };
    expect(
      box.built(stage, { tiles: 1, features: 1, skipped: 1, error: "tile 15/1/2: bad" })
    ).toEqual({ odc: KEY, odcTiles: 2, odcCatzoc: 4 });
    expect(box.note(0)).toBe("Open Data Charts: 1 tile(s) left out, unreadable: tile 15/1/2: bad");
    expect(box.built(stage, { tiles: 0, features: 0, skipped: 0, error: "disk full" })).toEqual({});
    expect(box.note(0)).toMatch(/^Open Data Charts not read: disk full/);
  });

  test("while the charts cannot be known the box stays; only charts gone rebuild it", () => {
    let key: string | null | undefined;
    const box = new OdcBox(TMP, {
      catzoc: 4,
      tiles: { key: () => key, stage: () => Promise.resolve(0) }
    });
    const record = { odc: KEY, odcTiles: 4, odcCatzoc: 4 };
    // No offer yet after a restart, or a list that cannot be read.
    expect(box.changed(BOX, record, 0)).toBe(false);
    key = KEY;
    expect(box.changed(BOX, record, 0)).toBe(false);
    key = null;
    expect(box.changed(BOX, record, 0)).toBe(true);
  });

  test("an aborted build's cleanup leaves the staging of the build that replaced it", async () => {
    const box = new OdcBox(TMP, {
      catzoc: 4,
      tiles: tiles((_bbox, file) => {
        fs.writeFileSync(file, "tiles");
        return Promise.resolve(1);
      })
    });
    const aborted = new AbortController();
    const first = await box.stage(BOX, 0, aborted.signal);
    let release = (): void => undefined;
    const running = OdcBox.whileStaged(
      first,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    aborted.abort();
    // The replacement stages while the aborted build has not settled yet.
    const second = await box.stage(BOX, 0, signal);
    release();
    await running;
    expect(first.job?.tiles).not.toBe(second.job?.tiles);
    expect(fs.existsSync(first.job?.tiles ?? "")).toBe(false);
    expect(fs.readFileSync(second.job?.tiles ?? "", "utf8")).toBe("tiles");
  });

  test("staging files of this or another live process are kept; a gone one's are removed", async () => {
    const own = path.join(TMP, `odc-tiles-${process.pid}-999999.bin`);
    const live = path.join(TMP, `odc-tiles-${process.ppid}-1.bin`);
    // Above any pid_max, so no such process.
    const gone = path.join(TMP, "odc-tiles-99999999-1.bin");
    const other = path.join(TMP, "odc-tiles-notes.txt");
    for (const f of [own, live, gone, other]) {
      fs.writeFileSync(f, "");
    }
    const box = new OdcBox(TMP, { catzoc: 4, tiles: tiles(() => Promise.resolve(0)) });
    expect(await box.stage(BOX, 0, signal)).toEqual({ key: KEY, catzoc: 4 });
    expect([own, live, gone, other].map((f) => fs.existsSync(f))).toEqual([
      true,
      true,
      false,
      true
    ]);
  });
});
