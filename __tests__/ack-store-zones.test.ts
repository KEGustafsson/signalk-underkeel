import fs from "fs";
import os from "os";
import path from "path";
import type { AckServiceDeps } from "../src/ack-service";
import { addAck, MAX_ACKS } from "../src/ack-service";
import { AckStore } from "../src/ack-store";
import type { Ack } from "../src/engine/acks";
import type { WaterLevel } from "../src/model/uncertainty";
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

  test("a failed save leaves the live list unchanged", () => {
    const file = path.join(dir, "acks.json");
    const store = new AckStore(file);
    store.add(ACK);
    // A directory where the temporary file should go makes every write fail.
    fs.mkdirSync(`${file}.tmp-${process.pid}`);
    expect(() => store.add({ ...ACK, id: "a2" })).toThrow();
    expect(() => store.remove("a1")).toThrow();
    expect(store.list(NOW).map((a) => a.id)).toEqual(["a1"]);
  });

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

  test("expired entries are dropped from the file on the next write", () => {
    const file = path.join(dir, "acks.json");
    const store = new AckStore(file);
    store.add({ ...ACK, id: "old", expires: new Date(NOW + 1000).toISOString() }, NOW);
    store.add(ACK, NOW + 2000);
    const saved = () => (JSON.parse(fs.readFileSync(file, "utf8")) as Ack[]).map((a) => a.id);
    expect(saved()).toEqual(["a1"]);
    store.add({ ...ACK, id: "old", expires: new Date(NOW + 1000).toISOString() }, NOW);
    expect(store.remove("old", NOW + 2000)).toBe(false);
    expect(store.remove("a1", NOW + 2000)).toBe(true);
    expect(saved()).toEqual([]);
  });

  test("a new acknowledgement past MAX_ACKS unexpired ones is refused", () => {
    const store = new AckStore(path.join(dir, "acks.json"));
    const square = [
      [22, 60],
      [22.01, 60],
      [22.01, 60.01],
      [22, 60.01],
      [22, 60]
    ];
    let now = NOW;
    const deps: AckServiceDeps = {
      store,
      current: () => undefined,
      heading: () => 1,
      waterLevel: (): WaterLevel => ({ h: 0, sigma: 0.1, source: "manual" }),
      draft: () => 1.8,
      now: () => now,
      error: () => undefined
    };
    const post = (ttl?: number) =>
      addAck({ polygon: { type: "Polygon", coordinates: [square] }, ttl }, deps).status;
    for (let i = 0; i < MAX_ACKS - 1; i++) {
      expect(post()).toBe(201);
    }
    expect(post(60)).toBe(201);
    expect(post()).toBe(409);
    // Once one lapses there is room again.
    now += 61_000;
    expect(post()).toBe(201);
    expect(store.list(now)).toHaveLength(MAX_ACKS);
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
    ).toEqual([{ name: "home", polygon: square.slice(0, -1), holes: [] }]);
    const multi = zonesFromRegion("r2", {
      feature: { geometry: { type: "MultiPolygon", coordinates: [[square], [square]] } }
    });
    expect(multi.map((z) => z.name)).toEqual(["r2", "r2"]);
  });

  test("holes cut out of a region are kept", () => {
    const hole = [
      [22.004, 60.004],
      [22.006, 60.004],
      [22.006, 60.006],
      [22.004, 60.004]
    ];
    const [zone] = zonesFromRegion("r3", {
      feature: { geometry: { type: "Polygon", coordinates: [square, hole] } }
    });
    expect(zone?.holes).toEqual([hole.slice(0, -1)]);
    expect(() =>
      zonesFromRegion("r4", {
        feature: { geometry: { type: "Polygon", coordinates: [square, [[22, 60]]] } }
      })
    ).toThrow(/no valid Polygon/);
  });

  test("a ring that is not closed is rejected, not cut short by a vertex", () => {
    // A square notched in to its centre: dropping the last point would fill the notch.
    const notched = [
      [22, 60],
      [22.02, 60],
      [22.02, 60.02],
      [22, 60.02],
      [22.01, 60.01]
    ];
    expect(() =>
      zonesFromRegion("r5", {
        feature: { geometry: { type: "Polygon", coordinates: [notched] } }
      })
    ).toThrow(/no valid Polygon/);
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
