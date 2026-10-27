import UKC = require("../../public/ukc-shared.js");
import { LIVENESS_KEEP_ALIVE_MS, LIVENESS_STALE_MS } from "../../src/tick-publisher";

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

  test("the widget shows the values, and a stale view as unknown with no numbers", () => {
    const view = { state: "warn", clearance: 0.42, timeToShoal: 95, message: "shoal ahead: P 7 %" };
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(UKC.widgetView({ ...view, stale: false }, "m", now)).toEqual({
      colour: UKC.stateStyle("warn").colour,
      state: "UKC Warning",
      line: "min 0.4 m · shoal in 95 s",
      reason: "shoal ahead"
    });
    expect(UKC.widgetView({ ...view, stale: true }, "m", now)).toEqual({
      colour: UKC.stateStyle("unknown").colour,
      state: "UKC Unknown",
      line: "min —",
      reason: "no data from the under-keel plugin"
    });
    expect(UKC.widgetView({ ...view, state: "normal", stale: true }, "m", now).state).toBe(
      "UKC Unknown"
    );
    // Back from a hidden page whose stale timer has not fired: the deadline still holds.
    const normal = { ...view, state: "normal", stale: false };
    expect(UKC.widgetView({ ...normal, freshUntil: now + 1 }, "m", now).state).toBe("UKC Normal");
    expect(UKC.widgetView({ ...normal, freshUntil: now }, "m", now)).toMatchObject({
      state: "UKC Unknown",
      reason: "no data from the under-keel plugin"
    });
  });

  test("the pages' stale limit is three of the plugin's liveness keep-alives", () => {
    expect(UKC.STALE_MS).toBe(LIVENESS_STALE_MS);
    expect(UKC.STALE_MS).toBe(3 * LIVENESS_KEEP_ALIVE_MS);
  });

  test("only a fresh state keeps the widget current; an old normal reads unknown", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const at = (s: number) => new Date(now + s * 1000).toISOString();
    const fresh = UKC.freshness(UKC.STALE_MS);
    const view: Record<string, unknown> = { state: "unknown", clearance: null, stale: true };
    // A state 10 s old, replayed on subscribe, is current for 5 s more.
    expect(UKC.widgetValue(view, "state", "normal", fresh("s", at(-10), now), now)).toBe(5000);
    expect(UKC.widgetView(view, "m", now + 4999).state).toBe("UKC Normal");
    // A clearance keep-alive arrives, but no state: the view still ages out with the state.
    expect(UKC.widgetValue(view, "clearance", 3.1, fresh("c", at(4), now + 4000), now + 4000)).toBe(
      null
    );
    expect(UKC.widgetView(view, "m", now + 5000)).toMatchObject({
      state: "UKC Unknown",
      line: "min —"
    });
    // A state older than the limit is not shown at all.
    const old: Record<string, unknown> = { state: "unknown", stale: true };
    expect(UKC.widgetValue(old, "state", "normal", fresh("s2", at(-16), now), now)).toBe(null);
    expect(old.state).toBe("unknown");
    expect(UKC.widgetView(old, "m", now).state).toBe("UKC Unknown");
    // Keep-alives every 5 s hold the view current with room for two missed ones.
    const live: Record<string, unknown> = { state: "unknown", stale: true };
    const f2 = UKC.freshness(UKC.STALE_MS);
    for (let s = 0; s <= 60; s += LIVENESS_KEEP_ALIVE_MS / 1000) {
      UKC.widgetValue(live, "state", "normal", f2("s", at(s), now + s * 1000), now + s * 1000);
    }
    expect(UKC.widgetView(live, "m", now + 60_000 + 2 * LIVENESS_KEEP_ALIVE_MS).state).toBe(
      "UKC Normal"
    );
    expect(UKC.widgetView(live, "m", now + 60_000 + UKC.STALE_MS).state).toBe("UKC Unknown");
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

  test("the freshness tracker remembers the latest timestamp per path", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const at = (s: number) => new Date(now + s * 1000).toISOString();
    const fresh = UKC.freshness(10000);
    expect(fresh("a", at(-60), now)).toBe(0);
    expect(fresh("a", at(-59), now)).toBe(10000);
    expect(fresh("a", at(-59), now)).toBe(0);
    expect(fresh("b", at(-59), now)).toBe(0);
    expect(fresh("a", at(-70), now)).toBe(0);
    expect(fresh("a", at(-58), now)).toBe(10000);
  });

  test("a route check reads as out of date once it is older than the re-check allows", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const at = (s: number) => new Date(now - s * 1000).toISOString();
    const ok = [{ status: "ok" }];
    const badge = (r: object) => UKC.routeBadge(r, now, 180000);
    expect(badge({ legs: ok, receivedAt: at(30) })).toEqual({ text: "ok", cls: "ok" });
    expect(badge({ legs: ok, receivedAt: at(600) })).toEqual({
      text: "out of date",
      cls: "unverified"
    });
    expect(badge({ legs: ok })).toEqual({ text: "out of date", cls: "unverified" });
    expect(badge({ legs: [], pending: true })).toEqual({
      text: "not checked yet",
      cls: "unverified"
    });
    expect(badge({ legs: ok, error: "x" })).toEqual({ text: "not checked", cls: "unverified" });
    expect(UKC.checkedAgo(at(20), now)).toBe("checked just now");
    expect(UKC.checkedAgo(at(150), now)).toBe("checked 3 min ago");
    expect(UKC.checkedAgo(at(3 * 3600), now)).toBe("checked 3 h ago");
    expect(UKC.checkedAgo(undefined, now)).toBe("");
  });

  test("the compact route result gives the same badge and leg rows as the full one", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const at = (s: number) => new Date(now - s * 1000).toISOString();
    const leg = (index: number, status: string, minUkc: number | null, risk: number) => ({
      index,
      status,
      from: [22 + index / 100, 60],
      to: [22 + (index + 1) / 100, 60],
      length: 560,
      eta: { start: at(0), end: at(-60) },
      minUkc,
      sigma: 0.4,
      risk,
      charted: minUkc === null ? null : minUkc + 2,
      flags: ["UNASSESSED"],
      worst: { position: [22, 60], hazard: { class: "SOUNDG", valsou: 2.1 } },
      explanation: { terms: [{ name: "draft", value: 1.8 }], text: "draft 1.8 m" }
    });
    const legs = [
      leg(0, "ok", 4.2, 0),
      leg(1, "marginal", 0.9, 0.012),
      leg(2, "unverified", null, 0)
    ];
    const results = [
      { name: "A", rev: 3, legs, checkedAt: at(5), receivedAt: at(4) },
      { name: "B", rev: 1, legs: [...legs, leg(3, "fail", -0.4, 0.93)], receivedAt: at(10) },
      { name: "C", rev: 2, legs, receivedAt: at(600) },
      { name: "D", rev: 2, legs: [], error: "route check failed: timeout" },
      { name: "E", legs: [], pending: true },
      { name: "F", legs: [leg(0, "ok", 4.2, 0)] }
    ];
    for (const full of results) {
      const compact: Record<string, unknown> & { legs: object[] } = UKC.compactResult(full);
      expect(UKC.routeBadge(compact, now, 180000)).toEqual(UKC.routeBadge(full, now, 180000));
      expect(UKC.checkedAgo(compact.receivedAt, now)).toBe(UKC.checkedAgo(full.receivedAt, now));
      expect(compact.error).toBe(full.error);
      expect(compact.pending).toBe(full.pending);
      for (const unit of ["m", "foot"]) {
        expect(compact.legs.map((l: object) => UKC.legRow(l, unit))).toEqual(
          full.legs.map((l: object) => UKC.legRow(l, unit))
        );
      }
    }
    const [first] = results;
    expect(JSON.stringify(UKC.compactResult(first)).length).toBeLessThan(
      JSON.stringify(first).length / 4
    );
    expect(UKC.legRow(legs[1], "m")).toEqual(["2", "marginal", "0.9 m", "1.2 %"]);
  });

  test("a route check asked for while one runs waits and runs once after it", () => {
    const gate = UKC.oneAtATime();
    expect(gate.start("r1")).toBe(true);
    expect(gate.start("r1")).toBe(false);
    expect(gate.start("r1")).toBe(false);
    expect(gate.start("r2")).toBe(true);
    expect(gate.end("r1")).toBe(true);
    expect(gate.start("r1")).toBe(true);
    expect(gate.end("r1")).toBe(false);
    expect(gate.end("r2")).toBe(false);
  });

  test("a busy server's Retry-After sets the wait before a route is checked again", () => {
    expect(UKC.retryAfterMs("2")).toBe(2000);
    expect(UKC.retryAfterMs(" 0 ")).toBe(1000);
    expect(UKC.retryAfterMs("3600")).toBe(30000);
    expect(UKC.retryAfterMs(null)).toBeNull();
    expect(UKC.retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });

  test("an envelopeRev that does not step by one means a restart or missed deltas", () => {
    expect(UKC.revJumped(undefined, 7)).toBe(false);
    expect(UKC.revJumped(7, 7)).toBe(false);
    expect(UKC.revJumped(7, 8)).toBe(false);
    expect(UKC.revJumped(7, 1)).toBe(true);
    expect(UKC.revJumped(7, 1760000000000)).toBe(true);
  });

  test("the water level has moved when it changes by more than the step or appears or goes", () => {
    expect(UKC.levelMoved(0.3, 0.305, 0.01)).toBe(false);
    expect(UKC.levelMoved(0.3, 0.32, 0.01)).toBe(true);
    expect(UKC.levelMoved(0.3, 0.28, 0.01)).toBe(true);
    expect(UKC.levelMoved(0.3, null, 0.01)).toBe(true);
    expect(UKC.levelMoved(null, 0, 0.01)).toBe(true);
    expect(UKC.levelMoved(null, null, 0.01)).toBe(false);
  });

  test("the plugin's change list says which UKC tiles to fetch again", () => {
    const tiles = UKC.tileRefresh();
    expect(tiles.query()).toBe("");
    const reply = (rev: number, more: object) => ({
      epoch: "e 1",
      rev,
      all: false,
      tiles: [],
      ...more
    });
    expect(tiles.polled(reply(3, {}), 0.5)).toBeNull();
    expect(tiles.query()).toBe("?epoch=e%201&rev=3");
    expect(tiles.polled(reply(4, { tiles: [[14, 1, 2]] }), 0.5)).toEqual([[14, 1, 2]]);
    // A wave height, σ, risk level or fallback change: every tile.
    expect(tiles.polled(reply(5, { all: true }), 0.5)).toBe("all");
    expect(tiles.query()).toBe("?epoch=e%201&rev=5");
  });

  test("a water level 1 cm from the last poll asks the change list again", () => {
    const tiles = UKC.tileRefresh();
    tiles.polled({ epoch: "e", rev: 0, all: false, tiles: [] }, 0.5);
    expect(tiles.level(0.505)).toBeNull();
    expect(tiles.level(0.512)).toBe("poll");
    expect(tiles.level(0.515)).toBeNull();
    expect(tiles.level(0.5)).toBe("poll");
    expect(tiles.level(null)).toBe("poll");
  });

  test("without the change list every tile is fetched on a 1 cm fall or a 10 cm rise", () => {
    const tiles = UKC.tileRefresh();
    tiles.polled({ epoch: "e", rev: 0, all: false, tiles: [] }, 0.5);
    // What changed since the last answer is unknown.
    expect(tiles.lost()).toBe("all");
    expect(tiles.lost()).toBeNull();
    expect(tiles.level(0.495)).toBeNull();
    expect(tiles.level(0.485)).toBe("all");
    // Higher water makes a stale tile show more danger, never less.
    expect(tiles.level(0.55)).toBeNull();
    expect(tiles.level(0.584)).toBeNull();
    expect(tiles.level(0.586)).toBe("all");
    expect(tiles.level(0.6, "fmi:forecast|")).toBeNull();
    expect(tiles.level(0.6, "fallback|FMI down")).toBe("all");
    expect(tiles.level(null)).toBe("all");
    expect(tiles.level(null)).toBeNull();
    expect(tiles.level(0)).toBe("all");
    // Once the list answers again, it decides.
    expect(tiles.polled({ epoch: "e", rev: 2, all: false, tiles: [[14, 1, 1]] }, 0)).toEqual([
      [14, 1, 1]
    ]);
    expect(tiles.level(0.05)).toBe("poll");
    expect(tiles.lost()).toBe("all");
  });

  test("the applied water level is keyed by its source and degraded reason", () => {
    const status = (applied?: object) => ({
      waterLevel: applied ? { source: "fmi", applied } : null
    });
    expect(UKC.waterSourceKey(status({ h: 0.4, source: "fmi:forecast" }))).toBe("fmi:forecast|");
    expect(UKC.waterSourceKey(status({ h: 0, source: "fallback", degraded: "FMI down" }))).toBe(
      "fallback|FMI down"
    );
    expect(UKC.waterSourceKey(status())).toBe("");
  });

  test("the panel names the water level the engine applies, and why it is degraded", () => {
    const applied = { h: 0, sigma: 0.3, source: "fallback", degraded: "FMI forecast unavailable" };
    expect(UKC.statusLines({ waterLevel: { source: "fmi", applied }, wfs: null }, "m")).toEqual([
      "Water level 0.0 m (fallback)",
      "Water level degraded: FMI forecast unavailable"
    ]);
    const forecast = { h: 0.42, sigma: 0.1, source: "fmi:forecast" };
    expect(
      UKC.statusLines(
        { waterLevel: { source: "fmi", applied: forecast }, wfs: { notice: "N" } },
        "m"
      )
    ).toEqual(["Water level 0.4 m (fmi:forecast)", "N"]);
    expect(UKC.statusLines({ waterLevel: null }, "m")).toEqual([]);
  });

  test("the panel shows the chart box rebuild, and why a leg outside the box is unverified", () => {
    const summary =
      "chart box rebuilding (10 km): building roots 3/10, started 2 min ago, first build";
    expect(UKC.statusLines({ chartBox: { summary } }, "m")).toEqual([summary]);
    expect(UKC.statusLines({ chartBox: { summary: null } }, "m")).toEqual([]);
    const reason = "the leg reaches outside the chart box around the vessel";
    const legs = [
      { index: 0, status: "unverified", minUkc: null, risk: 0, flags: ["NO_COVERAGE"], reason },
      { index: 1, status: "ok", minUkc: 2, risk: 0, flags: [] }
    ];
    expect(UKC.compactResult({ name: "A", legs }).legs).toEqual([
      { index: 0, status: "unverified", minUkc: null, risk: 0, reason },
      { index: 1, status: "ok", minUkc: 2, risk: 0 }
    ]);
  });
});
