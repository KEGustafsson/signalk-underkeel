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

const out = { setData: [], signalk: [], warnings: 0 };
console.warn = () => out.warnings++;
let routes = [];
let failList = false;
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
    set: async () => {
      if (fail.has("state")) throw new Error("quota exceeded");
    }
  },
  subscribe: async (patterns, cb) => {
    if (fail.has("subscribe")) throw new Error("subscribe failed");
    subs.push([patterns, cb]);
  },
  signalk: { subscribe: async (paths) => out.signalk.push(...paths) }
};
const emit = (name, params) =>
  subs.filter(([p]) => p.some((x) => name.startsWith(x.replace("**", "")))).forEach(([, cb]) => cb(name, params));
const statuses = () => (out.setData.at(-1) || []).map((f) => f.properties.status);

try {
  await import(process.cwd() + "/runtime.js");
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
