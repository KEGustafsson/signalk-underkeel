import UKC = require("../../public/ukc-shared.js");

describe("extension display logic", () => {
  test("depths follow the user's unit and refuse non-numbers", () => {
    expect(UKC.depth(2.04, "m")).toBe("2.0 m");
    expect(UKC.depth(3.048, "foot")).toBe("10.0 ft");
    expect(UKC.depth(null, "m")).toBe("—");
    expect(UKC.depth(-Infinity, "m")).toBe("—");
  });

  test("time to shoal and the reason before the explanation", () => {
    expect(UKC.timeToShoal(99)).toBe("in 99 s");
    expect(UKC.timeToShoal(600)).toBe("in 10 min");
    expect(UKC.timeToShoal(null)).toBe("");
    expect(UKC.reason("shoal ahead in 21 s: land + 0.2 m water level → P = > 99 %")).toBe(
      "shoal ahead in 21 s"
    );
    expect(UKC.reason("Under-keel clearance normal")).toBe("Under-keel clearance normal");
  });

  test("an unknown state shows as unknown, never as normal", () => {
    expect(UKC.stateStyle("alarm").label).toBe("ALARM");
    expect(UKC.stateStyle("bogus")).toEqual(UKC.stateStyle("unknown"));
  });

  test("route points become a line, and legs become features keyed by route and index", () => {
    expect(UKC.routeLine([{ position: [22, 60] }])).toBeNull();
    expect(UKC.routeLine([{ position: [22, 60, 0] }, { position: [22.1, 60.1] }])).toEqual({
      type: "LineString",
      coordinates: [
        [22, 60],
        [22.1, 60.1]
      ]
    });
    const legs = [
      { index: 0, status: "ok", from: [22, 60], to: [22.1, 60], risk: 0, minUkc: 4 },
      { index: 1, status: "fail", from: [22.1, 60], to: [22.2, 60], risk: 1, minUkc: null }
    ];
    const f = UKC.legFeatures("r1", legs);
    expect(f.map((x: { id: string }) => x.id)).toEqual(["r1:0", "r1:1"]);
    expect(f[1].properties.status).toBe("fail");
    expect(UKC.worstStatus(legs)).toBe("fail");
  });

  test("a route is never ok unless every leg is known to be ok", () => {
    const leg = (status?: string) => ({ status });
    expect(UKC.worstStatus([leg("ok"), leg("ok")])).toBe("ok");
    expect(UKC.worstStatus([leg("ok"), leg("marginal")])).toBe("marginal");
    expect(UKC.worstStatus([leg("ok"), leg("someday")])).toBe("unverified");
    expect(UKC.worstStatus([leg("ok"), leg()])).toBe("unverified");
    expect(UKC.worstStatus([leg("someday"), leg("fail")])).toBe("fail");
    expect(UKC.worstStatus([])).toBe("unverified");
    expect(UKC.worstStatus(undefined)).toBe("unverified");
  });

  test("a visible route without a result reads as not checked yet, and only visible routes show", () => {
    const checked = { r1: { name: "A", legs: [{ status: "ok" }] }, gone: { name: "B", legs: [] } };
    expect(UKC.routeEntries(checked, [{ routeId: "r1" }, { routeId: "r2", name: "C" }])).toEqual([
      ["r1", checked.r1],
      ["r2", { name: "C", legs: [], pending: true }]
    ]);
    expect(UKC.routeEntries(checked, null)).toEqual(Object.entries(checked));
    expect(UKC.routeEntries(undefined, [])).toEqual([]);
  });

  test("a value counts from its own timestamp, so a replayed old one is stale on arrival", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const ago = (s: number) => new Date(now - s * 1000).toISOString();
    expect(UKC.freshFor(ago(20 * 60), undefined, now, 10000)).toBe(0);
    expect(UKC.freshFor(ago(4), undefined, now, 10000)).toBe(6000);
    expect(UKC.freshFor(ago(-30), undefined, now, 10000)).toBe(10000);
    expect(UKC.freshFor(undefined, undefined, now, 10000)).toBe(0);
    expect(UKC.freshFor("not a time", undefined, now, 10000)).toBe(0);
  });

  test("a timestamp newer than the last one seen is live even when the clocks disagree", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const serverTime = now - 60000;
    const next = new Date(serverTime + 1000).toISOString();
    expect(UKC.freshFor(next, serverTime, now, 10000)).toBe(10000);
    expect(UKC.freshFor(new Date(serverTime).toISOString(), serverTime, now, 10000)).toBe(0);
  });
});
