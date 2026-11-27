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

  test("a staging file of this process is kept however old; a crashed one's is removed", async () => {
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    const own = path.join(TMP, `odc-tiles-${process.pid}-999999.bin`);
    const crashed = path.join(TMP, "odc-tiles-1-1.bin");
    for (const f of [own, crashed]) {
      fs.writeFileSync(f, "");
      fs.utimesSync(f, old, old);
    }
    const box = new OdcBox(TMP, { catzoc: 4, tiles: tiles(() => Promise.resolve(0)) });
    expect(await box.stage(BOX, 0, signal)).toEqual({ key: KEY, catzoc: 4 });
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(crashed)).toBe(false);
  });
});
