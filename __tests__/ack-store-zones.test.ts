import fs from "fs";
import os from "os";
import path from "path";
import { AckStore } from "../src/ack-store";
import type { Ack } from "../src/engine/acks";
import { loadZones, zonesFromRegion } from "../src/zones";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const ACK: Ack = {
  id: "a1",
  created: new Date(NOW).toISOString(),
  polygon: [
    [22, 60],
    [22.01, 60],
    [22.01, 60.01]
  ],
  heading: 1,
  sector: 0.3,
  waterLevel: 0.1,
  draft: 1.8
};

describe("acknowledgement store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-acks-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("entries survive a restart and expired ones are not listed", () => {
    const file = path.join(dir, "acks.json");
    const store = new AckStore(file);
    store.add(ACK);
    store.add({ ...ACK, id: "old", expires: new Date(NOW - 1).toISOString() });
    const again = new AckStore(file);
    expect(again.list(NOW).map((a) => a.id)).toEqual(["a1"]);
    expect(again.remove("a1")).toBe(true);
    expect(again.remove("a1")).toBe(false);
    expect(new AckStore(file).list(NOW)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["acks.json"]);
  });

  test("malformed entries are dropped and counted; an unreadable file starts empty with a reason", () => {
    const file = path.join(dir, "acks.json");
    fs.writeFileSync(
      file,
      JSON.stringify([ACK, { ...ACK, id: 7 }, { ...ACK, polygon: [[22, 60]] }])
    );
    const store = new AckStore(file);
    expect(store.list(NOW).map((a) => a.id)).toEqual(["a1"]);
    expect(store.dropped).toBe(2);
    fs.writeFileSync(file, "{not json");
    const broken = new AckStore(file);
    expect(broken.list(NOW)).toEqual([]);
    expect(broken.error).toMatch(/is not readable JSON/);
  });
});

describe("mooring zones from Signal K regions", () => {
  const square = [
    [22, 60],
    [22.01, 60],
    [22.01, 60.01],
    [22, 60.01],
    [22, 60]
  ];

  test("a Polygon or MultiPolygon region gives one zone per outer ring", () => {
    expect(
      zonesFromRegion("r1", {
        name: "home",
        feature: { geometry: { type: "Polygon", coordinates: [square] } }
      })
    ).toEqual([{ name: "home", polygon: square.slice(0, -1) }]);
    const multi = zonesFromRegion("r2", {
      feature: { geometry: { type: "MultiPolygon", coordinates: [[square], [square]] } }
    });
    expect(multi.map((z) => z.name)).toEqual(["r2", "r2"]);
  });

  test("a region that cannot be read is reported, not skipped", async () => {
    const { zones, errors } = await loadZones(["ok", "bad", "missing"], (id) =>
      id === "ok"
        ? Promise.resolve({ feature: { geometry: { type: "Polygon", coordinates: [square] } } })
        : id === "bad"
          ? Promise.resolve({ feature: { geometry: { type: "Point", coordinates: [22, 60] } } })
          : Promise.reject(new Error("not found"))
    );
    expect(zones).toHaveLength(1);
    expect(errors).toEqual([
      "mooring zone bad: region bad has no valid Polygon or MultiPolygon geometry",
      "mooring zone missing: not found"
    ]);
  });
});
