import fs from "fs";
import os from "os";
import path from "path";
import { AckStore } from "../../src/ack-store";
import {
  appendFileDurable,
  syncDirectory,
  writeFileDurable
} from "../../src/foundation/durable-file";
import { LivechartService } from "../../src/livechart-service";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { basin } from "../helpers/synthetic";

/** The fsync and rename calls in order, each fsync named by the path its fd was opened on. */
function recordSyncs() {
  const opened = new Map<number, string>();
  const events: string[] = [];
  const { openSync, fsyncSync, renameSync } = fs;
  const open = jest.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags: string) => {
    const fd = openSync(p, flags);
    opened.set(fd, String(p));
    return fd;
  }) as typeof fs.openSync);
  const sync = jest.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
    events.push(`fsync ${path.basename(opened.get(fd) ?? "?")}`);
    fsyncSync(fd);
  });
  const rename = jest.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    events.push(`rename ${path.basename(String(a))} ${path.basename(String(b))}`);
    renameSync(a, b);
  });
  return {
    events,
    restore: () => [open, sync, rename].forEach((s) => s.mockRestore())
  };
}

describe("durable writes", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-durable-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a replaced file is flushed before the rename and its directory after it", () => {
    const file = path.join(dir, "state.json");
    const r = recordSyncs();
    try {
      writeFileDurable(file, "new");
    } finally {
      r.restore();
    }
    const tmp = `state.json.tmp-${process.pid}`;
    expect(r.events).toEqual([
      `fsync ${tmp}`,
      `rename ${tmp} state.json`,
      `fsync ${path.basename(dir)}`
    ]);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
  });

  test("an append is flushed, and the directory too when the append created the file", () => {
    const file = path.join(dir, "log.ndjson");
    const r = recordSyncs();
    try {
      appendFileDurable(file, "a\n");
      appendFileDurable(file, "b\n");
    } finally {
      r.restore();
    }
    expect(r.events).toEqual([
      "fsync log.ndjson",
      `fsync ${path.basename(dir)}`,
      "fsync log.ndjson"
    ]);
    expect(fs.readFileSync(file, "utf8")).toBe("a\nb\n");
  });

  test("acks.json and livechart.json are written durably", () => {
    const r = recordSyncs();
    try {
      new AckStore(path.join(dir, "acks.json")).add({
        id: "a1",
        created: "2026-10-18T07:00:00Z",
        polygon: [
          [22, 60],
          [22.01, 60],
          [22.01, 60.01]
        ],
        heading: 1,
        sector: 0.3,
        waterLevel: 0.1,
        draft: 1.8
      });
      const lc = new LivechartService(
        buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 8), { minZoom: 12, leafZoom: 18 }),
        {
          source: {
            path: "environment.depth.belowSurface",
            transducerDepth: 0,
            forward: 0,
            starboard: 0
          },
          writeNotes: false,
          csb: { id: "anon", idType: "Other" }
        },
        path.join(dir, "livechart.json"),
        { setNote: () => Promise.resolve(), error: (m) => r.events.push(m) }
      );
      lc.onSounding({
        depth: 6,
        at: 1_800_000_000_000,
        position: [22.05, 60.05],
        positionAt: 1_800_000_000_000,
        hdop: 0.9,
        methodQuality: "GNSS Fix",
        waterLevel: { h: 0, sigma: 0.05, source: "manual" }
      });
      lc.save();
    } finally {
      r.restore();
    }
    for (const name of ["acks.json", "livechart.json"]) {
      const tmp = `${name}.tmp-${process.pid}`;
      const i = r.events.indexOf(`rename ${tmp} ${name}`);
      expect(r.events[i - 1]).toBe(`fsync ${tmp}`);
      expect(r.events[i + 1]).toBe(`fsync ${path.basename(dir)}`);
    }
  });
});

describe("syncDirectory", () => {
  const dir = os.tmpdir();
  afterEach(() => jest.restoreAllMocks());
  const failWith = (code: string) =>
    jest.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error(`${code}: fsync`), { code });
    });

  test("a flush that fails with an I/O error is thrown", () => {
    failWith("EIO");
    expect(() => syncDirectory(dir)).toThrow("EIO");
  });

  test.each(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"])(
    "a platform that cannot flush a directory (%s) is skipped",
    (code) => {
      failWith(code);
      expect(() => syncDirectory(dir)).not.toThrow();
    }
  );

  test("a directory that cannot be opened is skipped", () => {
    jest.spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("EISDIR: open"), { code: "EISDIR" });
    });
    expect(() => syncDirectory(dir)).not.toThrow();
  });
});
