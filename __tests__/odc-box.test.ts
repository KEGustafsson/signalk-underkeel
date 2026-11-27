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
  test("after a failed read the charts are read again 5 minutes after the failure", async () => {
    let clock = 0;
    const errors: string[] = [];
    const box = new OdcBox(
      TMP,
      {
        catzoc: 4,
        tiles: tiles(() => {
          // The reads before the failure took 4 minutes.
          clock = 240_000;
          return Promise.reject(new Error("tile store busy"));
        })
      },
      (m) => errors.push(m),
      () => clock
    );
    const staged = await box.stage(BOX, 0, signal);
    expect(staged).toEqual({});
    expect(errors).toHaveLength(1);
    expect(box.changed(BOX, OdcBox.record(staged), 539_999)).toBe(false);
    expect(box.changed(BOX, OdcBox.record(staged), 540_000)).toBe(true);
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
