import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import UKC = require("../../public/ukc-shared.js");

/**
 * The background runtime (public/runtime.js) run in a child Node process: an
 * ES module with top-level await that imports the extension bus, here a
 * stub. The driver below fakes the host client, document, fetch and clock,
 * runs one scenario and prints what the runtime did as JSON.
 */

const PUBLIC = path.resolve(__dirname, "..", "..", "public");

const DRIVER = String.raw`
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const [, , scenario, shared] = process.argv;
globalThis.UKC = require(shared);

// Timers run fifty times faster; the clock can jump ahead.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, ms, ...a) => realTimeout(f, (ms || 0) / 50, ...a);
let offset = 0;
const realNow = Date.now;
Date.now = () => realNow() + offset;
const wait = (ms) => new Promise((r) => realTimeout(r, ms));

const listeners = [];
globalThis.document = { hidden: false, addEventListener: (_t, f) => listeners.push(f) };

const LEG = { index: 0, from: [22, 60], to: [22.01, 60], status: "ok", risk: 0, minUkc: 2 };
const reply = (status, body) => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  json: async () => body
});
let held = null;
const hold = { on: false };
let routeChecks = 0;
globalThis.fetch = async (url) => {
  if (!String(url).endsWith("/route-check")) {
    return reply(503, { errors: ["no chart index loaded"] });
  }
  routeChecks++;
  if (hold.on) {
    hold.on = false;
    return new Promise((resolve) => (held = () => resolve(reply(200, { legs: [LEG] }))));
  }
  return reply(200, { legs: [LEG], checkedAt: new Date(Date.now()).toISOString() });
};

const out = { setData: [], signalk: [], states: [], warnings: 0 };
let sk = () => undefined;
console.warn = () => out.warnings++;
let routes = [];
let failList = false;
let hostDown = true;
const subs = [];
const fail = new Set((process.env.FAIL || "").split(",").filter(Boolean));
globalThis.__client = {
  hasCapability: (c) => ["routes", "overlays.data", "signalk.stream"].includes(c),
  call: async (name, params) => {
    if (name === "overlay.setData") {
      if (params.overlayId === "routecheck") out.setData.push(params.data.features);
    } else if (name === "route.list") {
      if (failList) throw new Error("route.list failed");
      return { routes: routes.map((routeId) => ({ routeId })) };
    } else if (name === "route.get") {
      return { name: params.routeId, rev: 1, points: [{ position: LEG.from }, { position: LEG.to }] };
    }
    return undefined;
  },
  state: {
    set: async (values) => {
      if (fail.has("state")) throw new Error("quota exceeded");
      if (fail.has("noticeDown") && "ukcNotice" in values && hostDown) throw new Error("host down");
      if (fail.has("noticeOnce") && "ukcNotice" in values && !out.failedNotice) {
        out.failedNotice = true;
        throw new Error("host busy");
      }
      if ("ukcNotice" in values) out.states.push(values.ukcNotice);
    }
  },
  subscribe: async (patterns, cb) => {
    if (fail.has("subscribe")) throw new Error("subscribe failed");
    subs.push([patterns, cb]);
  },
  signalk: {
    subscribe: async (paths, cb) => {
      out.signalk.push(...paths);
      sk = cb;
    }
  }
};
const emit = (name, params) =>
  subs.filter(([p]) => p.some((x) => name.startsWith(x.replace("**", "")))).forEach(([, cb]) => cb(name, params));
const statuses = () => (out.setData.at(-1) || []).map((f) => f.properties.status);

try {
  // A URL beside this driver: Windows paths are not import specifiers.
  await import(new URL("./runtime.js", import.meta.url).href);
  out.started = true;
} catch (err) {
  out.started = false;
  out.error = String(err);
}
if (scenario === "aging") {
  routes = ["R"];
  emit("ukc.checkRoutes", {});
  await wait(100);
  out.fresh = statuses();
  // Back from a long sleep while route.list fails: no check replaces the old result.
  offset = 4 * 60 * 1000;
  failList = true;
  listeners.forEach((f) => f());
  await wait(100);
  out.woken = statuses();
} else if (scenario === "hidden") {
  hold.on = true;
  emit("route.updated", { routeId: "R" });
  while (!held) await wait(5);
  // Another edit while the check runs: its check is refused and remembered.
  emit("route.updated", { routeId: "R" });
  await wait(100);
  emit("route.hidden", { routeId: "R" });
  held();
  await wait(200);
  out.routeChecks = routeChecks;
  out.after = statuses();
} else if (scenario === "notice") {
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const notice = (state, message) => sk({ path: "notifications.navigation.underKeel", timestamp: at, value: { state, message } });
  notice("warn", "shoal ahead in 2 min");
  // The same notification again, as on a reconnect: nothing new to tell the panel.
  notice("warn", "shoal ahead in 2 min");
  notice("normal", "Under-keel clearance normal");
  sk({ path: "notifications.navigation.underKeel", timestamp: at, value: null });
  await wait(50);
} else if (scenario === "notice-retry") {
  const at = new Date().toISOString();
  sk({ path: "notifications.navigation.underKeel", timestamp: at, value: { state: "warn", message: "shoal ahead" } });
  // The write fails once; no further notification comes, as for an unchanged warning.
  await wait(300);
} else if (scenario === "notice-giveup") {
  const at = new Date().toISOString();
  const warn = () => sk({ path: "notifications.navigation.underKeel", timestamp: at, value: { state: "warn", message: "shoal ahead" } });
  warn();
  // Every write and retry fails (30 s of retries, 600 ms here); then the host recovers and a
  // reconnect delivers the same notification again.
  await wait(1000);
  hostDown = false;
  warn();
  await wait(50);
} else if (scenario === "prune") {
  routes = ["R"];
  emit("ukc.checkRoutes", {});
  await wait(100);
  out.listed = statuses();
  routes = [];
  emit("ukc.checkRoutes", {});
  await wait(100);
  out.unlisted = statuses();
}
console.log(JSON.stringify(out));
process.exit(0);
`;

interface Run {
  started: boolean;
  error?: string;
  signalk: string[];
  states: { message: string; state?: string }[];
  fresh?: string[];
  woken?: string[];
  after?: string[];
  routeChecks?: number;
  listed?: string[];
  unlisted?: string[];
}

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-runtime-"));
  fs.copyFileSync(path.join(PUBLIC, "runtime.js"), path.join(dir, "runtime.js"));
  fs.mkdirSync(path.join(dir, "vendor", "plotterext-bus"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vendor", "plotterext-bus", "extension.js"),
    "export const connectExtension = async () => globalThis.__client;\n"
  );
  fs.writeFileSync(path.join(dir, "driver.mjs"), DRIVER);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(scenario: string, fail = ""): Run {
  const stdout = execFileSync(
    process.execPath,
    [path.join(dir, "driver.mjs"), scenario, path.join(PUBLIC, "ukc-shared.js")],
    { cwd: dir, env: { ...process.env, FAIL: fail }, timeout: 20000, encoding: "utf8" }
  );
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Run;
}

describe("extension runtime", () => {
  test.each([["state"], ["subscribe"], ["state,subscribe"]])(
    "a failing host call (%s) at start still subscribes to the look-ahead",
    (fail) => {
      const r = run("none", fail);
      expect(r.error).toBeUndefined();
      expect(r.started).toBe(true);
      expect(r.signalk).toContain("navigation.underKeel.envelopeRev");
    }
  );

  test("route legs older than the panel's limit turn unverified on the chart", () => {
    const r = run("aging");
    expect(r.fresh).toEqual(["ok"]);
    expect(r.woken).toEqual(["unverified"]);
  });

  test("a route hidden while its check runs does not come back on the chart", () => {
    const r = run("hidden");
    expect(r.routeChecks).toBe(1);
    expect(r.after).toEqual([]);
  });

  test("a route no longer listed loses its legs at the next check of all routes", () => {
    const r = run("prune");
    expect(r.listed).toEqual(["ok"]);
    expect(r.unlisted).toEqual([]);
  });
});

describe("the notification, relayed to the details panel", () => {
  test("the background page holds it and keeps each new message in the extension state", () => {
    const r = run("notice");
    expect(r.started).toBe(true);
    expect(r.signalk).toContain("notifications.navigation.underKeel");
    // Hours old, as a notification sent only on change can be, and still relayed.
    expect(r.states).toEqual([
      { message: "shoal ahead in 2 min", state: "warn" },
      { message: "Under-keel clearance normal", state: "normal" },
      { message: "" }
    ]);
  });

  test("a write the host refuses is tried again without waiting for another notification", () => {
    const r = run("notice-retry", "noticeOnce");
    expect(r.states).toEqual([{ message: "shoal ahead", state: "warn" }]);
  });

  test("a notice whose retries all failed is written when it arrives again", () => {
    const r = run("notice-giveup", "noticeDown");
    expect(r.states).toEqual([{ message: "shoal ahead", state: "warn" }]);
  });

  test("the panel, which opens and closes, holds no Signal K subscription of its own", () => {
    // The host unsubscribes a closed page's paths one by one, which Signal K refuses and logs.
    expect(fs.readFileSync(path.join(PUBLIC, "panel.js"), "utf8")).not.toMatch(
      /signalk\.subscribe/
    );
  });
});

describe("one run at a time", () => {
  test("a forgotten start is not run again after the run in progress", () => {
    const once = UKC.oneAtATime();
    expect(once.start("R")).toBe(true);
    expect(once.start("R")).toBe(false);
    once.forget("R");
    expect(once.end("R")).toBe(false);
  });
});

describe("route legs on the chart", () => {
  const legs = [{ index: 0, from: [22, 60], to: [22.01, 60], status: "ok", risk: 0, minUkc: 2 }];
  const now = Date.parse("2026-10-23T12:00:00Z");
  const at = (ageMs: number) => new Date(now - ageMs).toISOString();
  const statuses = (r: Record<string, unknown>) =>
    UKC.overlayLegs("R", r, now, UKC.ROUTE_MAX_AGE_MS).map(
      (f: { properties: { status: string } }) => f.properties.status
    );

  test("an ok leg stays ok while the panel shows its result as current", () => {
    expect(statuses({ legs, receivedAt: at(UKC.ROUTE_MAX_AGE_MS) })).toEqual(["ok"]);
    expect(
      UKC.routeBadge({ legs, receivedAt: at(UKC.ROUTE_MAX_AGE_MS) }, now, UKC.ROUTE_MAX_AGE_MS).text
    ).toBe("ok");
  });

  test("an older result, or one with no receipt time, is unverified, as on the panel", () => {
    for (const r of [{ legs, receivedAt: at(UKC.ROUTE_MAX_AGE_MS + 1) }, { legs }]) {
      expect(statuses(r)).toEqual(["unverified"]);
      expect(UKC.routeBadge(r, now, UKC.ROUTE_MAX_AGE_MS).text).toBe("out of date");
    }
  });
});
