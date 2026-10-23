import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import {
  buildChartIndex,
  loadChartIndex,
  recoverChartIndex,
  removeStaging,
  saveChartIndex
} from "../../src/spatial/chart-index";
import { HazardIndex } from "../../src/spatial/hazards";
import { FLAGS } from "../../src/spatial/node-store";
import { footprintGeom, mercatorBuffer, minDepthOver } from "../../src/spatial/pyramid";
import { deserializePyramid, serializePyramid } from "../../src/spatial/store";
import { boxRing, point } from "../helpers/synthetic";
import type { Box } from "../helpers/synthetic";

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "enc");
const OPTS = { minZoom: 12, leafZoom: 18 };

function fixtureIndex() {
  return buildChartIndex(
    [
      readCellDirectory(path.join(FIXTURES, "FI5SYNTH"), 0),
      readCellDirectory(path.join(FIXTURES, "FI4SYNTH"), 1)
    ],
    OPTS
  );
}

const at = (index: ReturnType<typeof fixtureIndex>, box: Box) =>
  minDepthOver(index.pyramid, footprintGeom(boxRing(box)));

describe("synthetic ENC scenario (plan §7)", () => {
  const index = fixtureIndex();

  test("catalogue keeps both editions", () => {
    expect(index.catalogue.cells.map((c) => [c.name, c.edition, c.update])).toEqual([
      ["FI5SYNTH", 3, 1],
      ["FI4SYNTH", 7, 0]
    ]);
  });

  test("the rock inside the swept fairway sets the depth", () => {
    const r = at(index, [22.0195, 60.0098, 22.0205, 60.0102]);
    expect(r.dMin).toBe(3.5);
    expect(r.cellRef).toBe(0);
  });

  test("the swept fairway away from the rock is 8 m and SWEPT", () => {
    const r = at(index, [22.003, 60.0098, 22.004, 60.0102]);
    expect(r.dMin).toBe(8);
    expect(r.flags & FLAGS.SWEPT).toBeTruthy();
  });

  test("the CATZOC C bank is shallow with C sigmas", () => {
    const r = at(index, [22.0115, 59.989, 22.0125, 59.99]);
    expect(r.dMin).toBe(1.8); // the shoal sounding on the bank, burned within k·σP
    expect(r.sigmaP).toBe(250);
  });

  test("band 4 fills where band 5 has no coverage, east of that is a gap", () => {
    const fill = at(index, [22.0362, 60.005, 22.0368, 60.006]);
    expect(fill.dMin).toBe(5);
    expect(fill.cellRef).toBe(1);
    const gap = at(index, [22.0395, 60.005, 22.0399, 60.006]);
    expect(gap.flags & FLAGS.NO_COVERAGE).toBeTruthy();
    expect(gap.dMin).toBe(-Infinity);
  });

  test("the island is land", () => {
    expect(at(index, [22.027, 60.014, 22.028, 60.015]).dMin).toBe(-Infinity);
  });

  test("the hazard tree names the rock", () => {
    const geom = footprintGeom([[22.0201, 60.0101]]);
    const near = index.hazards.near(
      geom,
      mercatorBuffer({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 50)
    );
    expect(near[0]?.feature.lnam).toBe("FI5-ROCK");
  });
});

describe("index persistence", () => {
  test("pyramid serialisation round-trips", () => {
    const index = fixtureIndex();
    const copy = deserializePyramid(serializePyramid(index.pyramid));
    expect(copy.count).toBe(index.pyramid.count);
    const box: Box = [22.0, 59.995, 22.04, 60.02];
    expect(minDepthOver(copy, footprintGeom(boxRing(box)))).toEqual(
      minDepthOver(index.pyramid, footprintGeom(boxRing(box)))
    );
  });

  test("rejects foreign and truncated files", () => {
    expect(() => deserializePyramid(Buffer.from("no header"))).toThrow(/header/);
    expect(() => deserializePyramid(Buffer.from('{"magic":"x","version":1}\n'))).toThrow(
      /unsupported/
    );
    const good = serializePyramid(fixtureIndex().pyramid);
    expect(() => deserializePyramid(good.subarray(0, good.length - 1))).toThrow(/truncated/);
  });

  test("a header count that disagrees with the body is refused, not laid out wrong", () => {
    const good = serializePyramid(fixtureIndex().pyramid);
    const nl = good.indexOf(0x0a);
    const header = JSON.parse(good.subarray(0, nl).toString("utf8")) as { count: number };
    const short = Buffer.concat([
      Buffer.from(JSON.stringify({ ...header, count: header.count - 1 })),
      good.subarray(nl)
    ]);
    expect(() => deserializePyramid(short)).toThrow(/corrupt/);
  });

  test("the columns are gzip-compressed and a flipped byte is refused", () => {
    const store = fixtureIndex().pyramid;
    const file = serializePyramid(store);
    const body = file.subarray(file.indexOf(0x0a) + 1);
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b]);
    // 36 bytes of columns per node uncompressed.
    expect(body.length).toBeLessThan((store.count * 36) / 4);
    const torn = Buffer.from(file);
    torn[torn.length - 100] = (torn[torn.length - 100] as number) ^ 0xff;
    expect(() => deserializePyramid(torn)).toThrow(/corrupt/);
  });

  test("refuses cells whose features name another catalogue entry", () => {
    const a = readCellDirectory(path.join(FIXTURES, "FI5SYNTH"), 0);
    const b = readCellDirectory(path.join(FIXTURES, "FI4SYNTH"), 0);
    expect(() => buildChartIndex([a, b], OPTS)).toThrow(/FI4SYNTH at index 1 .* cellRef 0/);
  });

  test("saving over an existing index replaces it whole", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-swap-"));
    try {
      const target = path.join(dir, "index");
      const two = fixtureIndex();
      saveChartIndex(target, two);
      const one = buildChartIndex([readCellDirectory(path.join(FIXTURES, "FI5SYNTH"), 0)], OPTS);
      saveChartIndex(target, one);
      expect(loadChartIndex(target).catalogue.cells.map((c) => c.name)).toEqual(["FI5SYNTH"]);
      expect(fs.readdirSync(dir)).toEqual(["index"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a save leaves another saver's staging and backup of the same process alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-threads-"));
    try {
      const target = path.join(dir, "index");
      saveChartIndex(target, fixtureIndex());
      // What a worker thread, which shares the process id, holds mid-save.
      const staging = `${target}.tmp-${process.pid}`;
      const backup = `${target}.old-${process.pid}`;
      fs.mkdirSync(staging);
      fs.cpSync(target, backup, { recursive: true });
      saveChartIndex(target, fixtureIndex());
      expect(fs.existsSync(staging)).toBe(true);
      expect(loadChartIndex(backup).catalogue.cells).toHaveLength(2);
      expect(fs.readdirSync(dir).sort()).toEqual(
        ["index", path.basename(backup), path.basename(staging)].sort()
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a crash between the renames is recovered from the moved-aside index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-crash-"));
    try {
      const target = path.join(dir, "index");
      saveChartIndex(target, fixtureIndex());
      fs.renameSync(target, `${target}.old-12345`);
      expect(recoverChartIndex(path.join(dir, "elsewhere"))).toBe(false);
      expect(loadChartIndex(target).catalogue.cells).toHaveLength(2);
      expect(fs.readdirSync(dir)).toEqual(["index"]);
      expect(recoverChartIndex(target)).toBe(false);
      expect(recoverChartIndex(path.join(dir, "missing-parent", "index"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("staging a dead process left is removed; a live one's, this one's and other names stay", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-index-"));
    try {
      const target = path.join(dir, "index");
      // The first recovery in a process also removes its own id's staging (index-commit.test.ts).
      recoverChartIndex(target);
      const exited = spawnSync(process.execPath, ["-e", ""]).pid;
      const names = [
        `index.tmp-${exited}-0-aa`,
        `index.tmp-${process.ppid}-0-ee`,
        `index.tmp-${process.pid}-3-bb`,
        `index.tmp-${process.pid}-4-cc`,
        "index.tmp-notes",
        "other.tmp-1-0-dd"
      ];
      names.forEach((n) => fs.mkdirSync(path.join(dir, n)));
      expect(recoverChartIndex(target)).toBe(false);
      removeStaging(target, (pid, thread) => pid === process.pid && thread === 3);
      expect(fs.readdirSync(dir).sort()).toEqual([names[1], ...names.slice(3)].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("save and load a chart index directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-index-"));
    try {
      const index = fixtureIndex();
      saveChartIndex(dir, index);
      const loaded = loadChartIndex(dir);
      expect(loaded.catalogue).toEqual(index.catalogue);
      expect(loaded.hazards.size).toBe(index.hazards.size);
      expect(loaded.pyramid.count).toBe(index.pyramid.count);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hazard tree", () => {
  test("finds hazards by box and orders by depth then distance", () => {
    const features = Array.from({ length: 200 }, (_, i) =>
      point(22 + (i % 20) * 0.001, 60 + Math.floor(i / 20) * 0.001, 10 + (i % 7), { lnam: `H${i}` })
    );
    features.push(point(22.0055, 60.0045, 1, { lnam: "SHOAL" }));
    const tree = new HazardIndex(features, 8);
    const geom = footprintGeom([[22.005, 60.0045]]);
    const hits = tree.near(geom, 200);
    expect(hits[0]?.feature.lnam).toBe("SHOAL");
    const depths = hits.map((h) => h.feature.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(new HazardIndex([]).near(geom, 1000)).toEqual([]);
  });
});

describe("durable save", () => {
  test("every file and both directories are flushed to disk, the staging before its rename", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-fsync-"));
    const real = { open: fs.openSync, fsync: fs.fsyncSync, rename: fs.renameSync };
    const events: string[] = [];
    const fds = new Map<number, string>();
    const name = (p: fs.PathLike) =>
      path
        .relative(dir, String(p))
        .split(path.sep)
        .join("/")
        .replace(/\.tmp-[^/]+/, ".tmp");
    const open = jest.spyOn(fs, "openSync").mockImplementation(((
      p: fs.PathLike,
      flags: fs.OpenMode
    ) => {
      const fd = real.open(p, flags);
      fds.set(fd, name(p));
      return fd;
    }) as typeof fs.openSync);
    const fsync = jest.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      events.push(`fsync ${fds.get(fd) ?? fd}`);
      real.fsync(fd);
    });
    const rename = jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      events.push(`rename ${name(from)}`);
      real.rename(from, to);
    });
    try {
      saveChartIndex(path.join(dir, "index"), fixtureIndex());
      const files = ["cells.json", "pyramid.bin", "hazards.json"].map(
        (f) => `fsync index.tmp/${f}`
      );
      // Windows cannot open a directory; NTFS journals the rename itself.
      expect(events).toEqual(
        process.platform === "win32"
          ? [...files, "rename index.tmp"]
          : [...files, "fsync index.tmp", "rename index.tmp", "fsync "]
      );
    } finally {
      [open, fsync, rename].forEach((s) => s.mockRestore());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
